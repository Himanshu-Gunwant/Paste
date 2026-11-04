import type { Prisma } from '../generated/prisma/client.js';
import type { DeletedBy, Paste } from '../generated/prisma/client.js';
import { TOMBSTONE_RETENTION_DAYS } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';

/** Transaction-capable client — pass `prisma` directly or a tx callback client. */
type Db = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical live predicate (docs/ARCHITECTURE.md §5.3): deleted_at IS NULL
 * AND (expires_at IS NULL OR expires_at > now()). Volatile now() exists only
 * here in queries — never in index predicates.
 */
export function livePasteWhere(now: Date = new Date()) {
  return {
    deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export const pasteRepository = {
  create(
    data: {
      id: string;
      authorId: string | null;
      customSlug?: string | null;
      title?: string | null;
      description?: string | null;
      language?: string | null;
      detectedLanguage?: string | null;
      content: string;
      contentSize: number;
      contentHash: string;
      visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
      passwordHash?: string | null;
      maxViews?: number | null;
      burnAfterRead?: boolean;
      expiresAt?: Date | null;
      forkOfId?: string | null;
    },
    db: Db = prisma,
  ): Promise<Paste> {
    return db.paste.create({ data });
  },

  createRevision(
    data: {
      pasteId: string;
      revisionNo: number;
      title?: string | null;
      description?: string | null;
      language?: string | null;
      content: string;
      contentSize: number;
      editorId?: string | null;
    },
    db: Db = prisma,
  ) {
    return db.pasteRevision.create({ data });
  },

  deleteRevision(pasteId: string, revisionNo: number, db: Db = prisma): Promise<number> {
    return db.pasteRevision
      .deleteMany({ where: { pasteId, revisionNo } })
      .then((r) => r.count);
  },

  /** Id-or-slug lookup under the canonical live predicate. */
  findByIdOrSlug(idOrSlug: string): Promise<(Paste & { author: { id: string; username: string } | null }) | null> {
    return prisma.paste.findFirst({
      where: {
        AND: [
          { OR: [{ id: idOrSlug }, { customSlug: idOrSlug }] },
          livePasteWhere(),
        ],
      },
      include: { author: { select: { id: true, username: true } } },
    });
  },

  /**
   * Burn-after-read atomic consumption (docs/ARCHITECTURE.md §9): ONE
   * transaction — the guarded UPDATE (row lock + `burned_at IS NULL` claim
   * guard) followed by content nulling. Exactly one concurrent consumer
   * wins; losers get 0 rows. Unauthorized requests never reach this.
   */
  async consumeBurn(pasteId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.paste.updateMany({
        where: {
          id: pasteId,
          burnAfterRead: true,
          burnedAt: null,
          deletedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { burnedAt: new Date(), deletedAt: new Date(), deletedBy: 'SYSTEM' },
      });
      if (claimed.count === 0) return false;
      await tx.paste.update({ where: { id: pasteId }, data: { content: null } });
      return true;
    });
  },

  /**
   * Synchronous exact view enforcement for max_views pastes (§4 K) — needs a
   * column-to-column comparison (view_count < max_views) that Prisma's where
   * cannot express; parameterized raw SQL, single statement, race-safe.
   */
  async incrementViewGuarded(pasteId: string): Promise<bigint | null> {
    const rows = await prisma.$queryRaw<{ view_count: bigint }[]>`
      UPDATE pastes SET view_count = view_count + 1
      WHERE id = ${pasteId}
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_views IS NULL OR view_count < max_views)
      RETURNING view_count
    `;
    return rows[0]?.view_count ?? null;
  },

  /** Buffered flush application (§12.2) — exact-once deltas applied by the worker. */
  incrementViewCount(pasteId: string, delta: bigint, db: Db = prisma): Promise<Paste> {
    return db.paste.update({
      where: { id: pasteId },
      data: { viewCount: { increment: delta } },
    });
  },

  viewDailyIncrement(pasteId: string, day: Date, delta: bigint, db: Db = prisma) {
    return db.pasteViewDaily.upsert({
      where: { pasteId_day: { pasteId, day } },
      create: { pasteId, day, views: delta },
      update: { views: { increment: delta } },
    });
  },

  /** Sets the tombstone (content nulled in the same write) — idempotent. */
  update(
    id: string,
    patch: {
      content?: string | null;
      contentSize?: number;
      contentHash?: string;
      latestRevisionNo?: number;
      title?: string | null;
      description?: string | null;
      language?: string | null;
      visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
      passwordHash?: string | null;
      maxViews?: number | null;
      burnAfterRead?: boolean;
      expiresAt?: Date | null;
    },
    db: Db = prisma,
  ): Promise<Paste> {
    return db.paste.update({ where: { id }, data: patch });
  },

  softDelete(pasteId: string, deletedBy: DeletedBy, db: Db = prisma): Promise<number> {
    return db.paste
      .updateMany({
        where: { id: pasteId, deletedAt: null },
        data: { content: null, deletedAt: new Date(), deletedBy },
      })
      .then((r) => r.count);
  },

  /** Expiry sweep scan (authoritative — works without Redis/jobs, §10). */
  async tombstoneExpired(now: Date, limit: number): Promise<string[]> {
    const rows = await prisma.paste.findMany({
      where: { expiresAt: { lte: now }, deletedAt: null },
      select: { id: true },
      take: limit,
    });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await prisma.paste.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { content: null, deletedAt: now, deletedBy: 'SYSTEM' },
    });
    return ids;
  },

  /** Purge sweeper: hard-delete tombstones past their retention window (§5.2). */
  async purgeTombstones(now: Date, limit: number): Promise<number> {
    const systemCutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS.SYSTEM * DAY_MS);
    const userCutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS.USER * DAY_MS);
    const rows = await prisma.paste.findMany({
      where: {
        deletedAt: { not: null, lte: now },
        OR: [
          { deletedBy: 'SYSTEM', deletedAt: { lte: systemCutoff } },
          { deletedBy: 'MODERATOR', deletedAt: { lte: systemCutoff } },
          { deletedBy: 'USER', deletedAt: { lte: userCutoff } },
        ],
      },
      select: { id: true },
      take: limit,
    });
    if (rows.length === 0) return 0;
    const result = await prisma.paste.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return result.count;
  },

  deleteHard(pasteId: string, db: Db = prisma): Promise<number> {
    return db.paste.deleteMany({ where: { id: pasteId } }).then((r) => r.count);
  },
};
