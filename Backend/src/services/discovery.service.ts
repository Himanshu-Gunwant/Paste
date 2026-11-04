import { Prisma } from '../generated/prisma/client.js';
import { PAGINATION, REDIS_KEYS, TRENDING_TOP_N, TRENDING_WINDOW_DAYS } from '../config/constants.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { decodeCursor, encodeCursor, type KeysetCursor } from '../lib/pagination.js';
import type { Paste } from '../generated/prisma/client.js';

/**
 * Public discovery (docs/ARCHITECTURE.md §4 G). Every query filters
 * visibility = 'PUBLIC' AND deleted_at IS NULL AND (expires_at IS NULL OR
 * expires_at > now()) AND author active-or-anonymous AT THE DATABASE LEVEL —
 * unlisted/private content cannot leak through any discovery endpoint.
 * Pagination is keyset (cursor) everywhere; trending uses a bounded top-N
 * zset with offset paging (§18).
 */

export interface PasteSummary {
  id: string;
  title: string | null;
  description: string | null;
  language: string | null;
  detectedLanguage: string | null;
  visibility: string;
  viewCount: string;
  authorUsername: string | null;
  createdAt: Date;
}

type FeedRow = Paste & { author: { username: string } | null };

function toSummary(paste: FeedRow): PasteSummary {
  return {
    id: paste.id,
    title: paste.title,
    description: paste.description,
    language: paste.language,
    detectedLanguage: paste.detectedLanguage,
    visibility: paste.visibility.toLowerCase(),
    viewCount: paste.viewCount.toString(),
    authorUsername: paste.author?.username ?? null,
    createdAt: paste.createdAt,
  };
}

/** PUBLIC + live + author-active-or-anonymous — shared by every discovery query. */
function publicLiveWhere(now: Date) {
  return {
    AND: [
      { visibility: 'PUBLIC' as const },
      { deletedAt: null },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ authorId: null }, { author: { status: 'ACTIVE' as const, deletedAt: null } }] },
    ],
  };
}

export type FeedSort = 'latest' | 'popular' | 'trending';

export interface ListOptions {
  sort?: FeedSort;
  language?: string;
  username?: string;
  cursor?: string;
  limit?: number;
}

function authorFilter(username?: string) {
  if (!username) return {};
  return { author: { username, status: 'ACTIVE' as const, deletedAt: null } };
}

export async function listPublicPastes(options: ListOptions = {}): Promise<{ data: PasteSummary[]; pagination: { cursor?: string; hasMore: boolean } }> {
  const limit = Math.min(Math.max(options.limit ?? PAGINATION.DEFAULT_LIMIT, 1), PAGINATION.MAX_LIMIT);
  const sort: FeedSort = options.sort ?? 'latest';
  const now = new Date();
  const base = publicLiveWhere(now);
  const filters = {
    ...(options.language ? { language: options.language } : {}),
    ...authorFilter(options.username),
  };

  if (sort === 'trending') {
    return listTrending(options);
  }

  const cursor: KeysetCursor | null = decodeCursor(options.cursor);

  if (sort === 'popular') {
    const keyset = cursor
      ? {
          OR: [
            { viewCount: { lt: BigInt(cursor.v ?? '0') } },
            { viewCount: BigInt(cursor.v ?? '0'), id: { lt: cursor.id } },
          ],
        }
      : {};
    const rows = await prisma.paste.findMany({
      where: { AND: [base, filters, keyset] },
      orderBy: [{ viewCount: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { author: { select: { username: true } } },
    });
    const page = buildPage(rows, limit, (row) => ({
      t: row.createdAt.toISOString(),
      id: row.id,
      v: row.viewCount!.toString(),
    }));
    return { data: rows.map(toSummary), pagination: page };
  }

  // latest — (created_at, id) keyset
  const keyset = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.t) } },
          { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
        ],
      }
    : {};
  const rows = await prisma.paste.findMany({
    where: { AND: [base, filters, keyset] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: { author: { select: { username: true } } },
  });
  const latestPage = buildPage(rows, limit, (row) => ({ t: row.createdAt.toISOString(), id: row.id }));
  return { data: rows.map(toSummary), pagination: latestPage };
}

function buildPage(
  rows: (Paste & { author?: { username: string } | null })[],
  limit: number,
  cursorFor: (row: { createdAt: Date; id: string; viewCount?: bigint }) => KeysetCursor,
): { cursor?: string; hasMore: boolean } {
  if (rows.length < limit) return { hasMore: false };
  const last = rows[rows.length - 1]!;
  return { cursor: encodeCursor(cursorFor(last)), hasMore: true };
}

/** §4 G: trending = 48 h view sums, recomputed into a bounded zset every 5 min. */
export async function recomputeTrending(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<{ paste_id: string; total: bigint }[]>`
    SELECT pv.paste_id, SUM(pv.views) AS total
    FROM paste_view_daily pv
    JOIN pastes p ON p.id = pv.paste_id
    WHERE pv.day >= ${since}
      AND p.visibility = 'PUBLIC'
      AND p.deleted_at IS NULL
      AND (p.expires_at IS NULL OR p.expires_at > now())
    GROUP BY pv.paste_id
    ORDER BY total DESC
    LIMIT ${TRENDING_TOP_N}
  `;
  const redis = getRedis();
  const key = REDIS_KEYS.trending();
  await redis.del(key);
  if (rows.length > 0) {
    await redis.zadd(
      key,
      ...rows.flatMap((row) => [Number(row.total), row.paste_id]),
    );
    await redis.expire(key, 15 * 60);
  }
  return rows.length;
}

async function listTrending(options: ListOptions): Promise<{ data: PasteSummary[]; pagination: { cursor?: string; hasMore: boolean } }> {
  const limit = Math.min(Math.max(options.limit ?? PAGINATION.DEFAULT_LIMIT, 1), PAGINATION.MAX_LIMIT);
  const offset = Number.parseInt(options.cursor ?? '0', 10) || 0;
  const redis = getRedis();
  const idsWithScores = await redis.zrevrange(REDIS_KEYS.trending(), offset, offset + limit - 1);
  const ids = idsWithScores.filter((value) => !value.includes('.')).slice(0, limit);
  if (ids.length === 0) return { data: [], pagination: { hasMore: false } };

  const rows = await prisma.paste.findMany({
    where: { id: { in: ids }, ...publicLiveWhere(new Date()), ...authorFilter(options.username), ...(options.language ? { language: options.language } : {}) },
    include: { author: { select: { username: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((row): row is FeedRow => row !== undefined)
    .map(toSummary);

  const hasMore = (await redis.zcard(REDIS_KEYS.trending())) > offset + ids.length;
  return {
    data: ordered,
    pagination: { ...(hasMore ? { cursor: String(offset + ids.length) } : {}), hasMore },
  };
}

export interface SearchOptions extends ListOptions {
  q: string;
}

/** FTS over title+description via the generated tsvector — raw SQL (Prisma
 *  cannot express tsvector matching); fully parameterized. */
export async function searchPublicPastes(options: SearchOptions): Promise<{ data: PasteSummary[]; pagination: { cursor?: string; hasMore: boolean } }> {
  const limit = Math.min(Math.max(options.limit ?? PAGINATION.DEFAULT_LIMIT, 1), PAGINATION.MAX_LIMIT);
  const cursor = decodeCursor(options.cursor);

  const conditions: Prisma.Sql[] = [
    Prisma.sql`p.visibility = 'PUBLIC'`,
    Prisma.sql`p.deleted_at IS NULL`,
    Prisma.sql`(p.expires_at IS NULL OR p.expires_at > now())`,
    Prisma.sql`(p.author_id IS NULL OR (u.status = 'ACTIVE' AND u.deleted_at IS NULL))`,
    Prisma.sql`p.search_vector @@ plainto_tsquery('english', ${options.q})`,
  ];
  if (options.language) conditions.push(Prisma.sql`p.language = ${options.language}`);
  if (options.username) conditions.push(Prisma.sql`u.username = ${options.username}`);
  if (cursor) {
    conditions.push(
      Prisma.sql`((p.created_at < ${new Date(cursor.t)}) OR (p.created_at = ${new Date(cursor.t)} AND p.id < ${cursor.id}))`,
    );
  }

  const rows = await prisma.$queryRaw<{
    id: string;
    title: string | null;
    description: string | null;
    language: string | null;
    detected_language: string | null;
    view_count: bigint;
    created_at: Date;
    username: string | null;
  }[]>`
    SELECT p.id, p.title, p.description, p.language, p.detected_language,
           p.view_count, p.created_at, u.username
    FROM pastes p
    LEFT JOIN users u ON u.id = p.author_id
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limit}
  `;

  const summaries: PasteSummary[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    language: row.language,
    detectedLanguage: row.detected_language,
    visibility: 'public',
    viewCount: row.view_count.toString(),
    authorUsername: row.username,
    createdAt: new Date(row.created_at),
  }));

  const hasMore = rows.length === limit;
  const last = rows[rows.length - 1];
  return {
    data: summaries,
    pagination: {
      ...(hasMore && last
        ? { cursor: encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) }
        : {}),
      hasMore,
    },
  };
}

/** Language facet counts for the filter UI — cached 5 min, fail-open. */
export async function getLanguageFacets(): Promise<{ language: string; count: number }[]> {
  const redis = getRedis();
  try {
    const cached = await redis.get(REDIS_KEYS.languagesCache());
    if (cached) return JSON.parse(cached) as { language: string; count: number }[];
  } catch {
    // cache unavailable → compute fresh
  }
  const rows = await prisma.paste.groupBy({
    by: ['language'],
    where: {
      AND: [
        { visibility: 'PUBLIC' },
        { deletedAt: null },
        { language: { not: null } },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        { OR: [{ authorId: null }, { author: { status: 'ACTIVE', deletedAt: null } }] },
      ],
    },
    _count: { language: true },
    orderBy: { _count: { language: 'desc' } },
  });
  const facets = rows
    .filter((row) => row.language !== null)
    .map((row) => ({ language: row.language as string, count: row._count.language }));
  try {
    await redis.set(REDIS_KEYS.languagesCache(), JSON.stringify(facets), 'EX', 300);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'language facet cache write failed');
  }
  return facets;
}
