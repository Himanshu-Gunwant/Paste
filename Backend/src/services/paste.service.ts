import { sha256Hex } from './hash.js';
import {
  EXPIRES_IN_PRESETS_SECONDS,
  MAX_PASTE_CONTENT_BYTES,
  MAX_REVISIONS_PER_PASTE,
  PASTE_ID_COLLISION_RETRIES,
  REDIS_KEYS,
  TOMBSTONE_RETENTION_DAYS,
  MGMT_CACHE_TTL_SECONDS,
} from '../config/constants.js';
import { AppError } from '../lib/errors.js';
import { generatePasteId, generateToken, hashToken } from '../lib/tokens.js';
import { detectLanguage } from '../lib/language-detect.js';
import { hashPastePassword, verifyPastePassword } from '../lib/crypto.js';
import { getRedis } from '../lib/redis.js';
import { pasteRepository, livePasteWhere } from '../repositories/paste.repository.js';
import { pasteTokenRepository } from '../repositories/paste-token.repository.js';
import { prisma } from '../lib/prisma.js';
import { authorizePasteManage, authorizePasteView, type PasteViewContext } from './access-policy.js';
import { consumeAnonymousPasteQuota } from './anonymous-quota.service.js';
import { assertNotUploadBanned } from './admin.service.js';
import { recordView, visitorHash } from './view.service.js';
import { cancelPasteExpiration, schedulePasteExpiration, schedulePastePurge } from '../queues/paste-jobs.js';
import type { AuthContext } from '../types/auth.js';
import type { CreatePasteBody, UpdatePasteBody } from '../validators/paste.validators.js';

/**
 * Paste business logic (docs/ARCHITECTURE.md §4 A/B/C, §9, §11). The service
 * is the authorization boundary: every path funnels through
 * authorizePasteView / authorizePasteManage, and all reads run under the
 * canonical live predicate (deleted_at IS NULL AND expiry > now()).
 */

export type PasteWithAuthor = NonNullable<Awaited<ReturnType<typeof pasteRepository.findByIdOrSlug>>>;

function resolveExpiry(body: { expiresIn?: keyof typeof EXPIRES_IN_PRESETS_SECONDS; expiresAt?: string | null }): Date | null | undefined {
  if (body.expiresIn) {
    return new Date(Date.now() + EXPIRES_IN_PRESETS_SECONDS[body.expiresIn] * 1000);
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) return null;
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) throw AppError.validation('Invalid expiresAt timestamp');
    if (parsed.getTime() <= Date.now()) throw AppError.validation('expiresAt must be in the future');
    return parsed;
  }
  return undefined; // unchanged
}

function assertByteLimit(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_PASTE_CONTENT_BYTES) {
    throw AppError.payloadTooLarge(`Content exceeds the ${MAX_PASTE_CONTENT_BYTES} byte limit`);
  }
}

async function resolvePasteId(customSlug: string | undefined): Promise<string> {
  if (customSlug) {
    const existing = await prisma.paste.findFirst({
      where: { OR: [{ id: customSlug }, { customSlug }] },
      select: { id: true },
    });
    if (existing) throw AppError.conflict('Slug is already taken');
    return customSlug;
  }
  for (let attempt = 0; attempt < PASTE_ID_COLLISION_RETRIES; attempt++) {
    const candidate = generatePasteId();
    const existing = await prisma.paste.findFirst({ where: { id: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw AppError.conflict('Could not allocate a paste id, please retry');
}

/** Best-effort denormalized storage counter (nightly reconcile is authoritative, §4 K). */
async function adjustStorage(authorId: string | null, delta: number): Promise<void> {
  if (!authorId || delta === 0) return;
  try {
    await prisma.user.update({
      where: { id: authorId },
      data: { storageUsed: { increment: BigInt(delta) } },
    });
  } catch {
    // user gone / race — nightly reconcile corrects
  }
}

export interface CreatePasteOptions {
  ip: string | null;
}

export async function createPaste(
  body: CreatePasteBody,
  auth: AuthContext,
  options: CreatePasteOptions,
): Promise<{ paste: PasteWithAuthor; managementToken?: string }> {
  assertByteLimit(body.content);

  const authorId = auth.kind === 'anonymous' ? null : auth.user.id;
  if (authorId === null) {
    await consumeAnonymousPasteQuota(options.ip);
  } else {
    await assertNotUploadBanned(authorId);
  }

  const id = await resolvePasteId(body.customSlug);
  const expiresAt = resolveExpiry(body) ?? null;
  const passwordHash = body.password ? await hashPastePassword(body.password) : null;
  const detected = body.language ?? detectLanguage(body.content);
  const managementToken = authorId === null ? generateToken() : undefined;

  const created = await prisma.$transaction(async (tx) => {
    const paste = await pasteRepository.create(
      {
        id,
        authorId,
        customSlug: body.customSlug ?? null,
        title: body.title ?? null,
        description: body.description ?? null,
        language: body.language ?? null,
        detectedLanguage: detected ?? null,
        content: body.content,
        contentSize: Buffer.byteLength(body.content, 'utf8'),
        contentHash: sha256Hex(body.content),
        visibility: body.visibility?.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE',
        passwordHash,
        maxViews: body.maxViews ?? null,
        burnAfterRead: body.burnAfterRead,
        expiresAt,
      },
      tx,
    );
    await pasteRepository.createRevision(
      {
        pasteId: paste.id,
        revisionNo: 1,
        title: paste.title,
        description: paste.description,
        language: paste.language,
        content: body.content,
        contentSize: paste.contentSize,
        editorId: authorId,
      },
      tx,
    );
    if (managementToken) {
      await pasteTokenRepository.create(
        {
          pasteId: paste.id,
          tokenHash: hashToken(managementToken),
          purpose: 'MANAGEMENT',
          createdBy: null,
          // Mirrors the paste TTL; NULL = valid while the paste exists (§5.2).
          expiresAt: expiresAt,
        },
        tx,
      );
    }
    return paste;
  });

  await adjustStorage(authorId, created.contentSize);

  // Optional read-through cache (DB hash remains authoritative — §4 B).
  if (managementToken) {
    void getRedis()
      .set(REDIS_KEYS.mgmtCache(created.id), hashToken(managementToken), 'EX', MGMT_CACHE_TTL_SECONDS)
      .catch(() => undefined);
  }
  // Delayed expire job = optimization only; the sweeper is authoritative.
  if (created.expiresAt) {
    void schedulePasteExpiration(created.id, created.expiresAt).catch(() => undefined);
  }

  const fresh = await pasteRepository.findByIdOrSlug(created.id);
  return { paste: fresh ?? created as PasteWithAuthor, managementToken };
}

export interface GetPasteOptions {
  password?: string;
  shareToken?: string;
  managementToken?: string;
  /** Burn consumption + view counting are suppressed for internal flows (fork). */
  countView?: boolean;
  visitorIp?: string | null;
  visitorUserAgent?: string | null;
}

export interface PasteViewResult {
  paste: PasteWithAuthor;
  /** True when this delivery consumed a burn-after-read paste. */
  consumed: boolean;
  /** True when authorization came from a management token. */
  viaManagementToken: boolean;
}

/**
 * The single authorized read path (§9). Order matters: SQL live filter →
 * policy decision → password gate → burn claim / max_views guard → view count.
 */
export async function getPasteForView(
  idOrSlug: string,
  auth: AuthContext,
  options: GetPasteOptions = {},
): Promise<PasteViewResult> {
  const paste = await pasteRepository.findByIdOrSlug(idOrSlug);
  if (!paste) throw AppError.notFound(); // uniform: missing = private = expired = burned

  const ctx = await buildViewContext(paste.id, auth, options);
  const decision = authorizePasteView(paste, ctx);

  if (decision.outcome === 'NOT_FOUND') throw AppError.notFound();

  if (decision.outcome === 'PASSWORD_REQUIRED') {
    if (!options.password) {
      throw new AppError('PASSWORD_REQUIRED', 401, 'This paste is password-protected');
    }
    const ok = await verifyPastePassword(paste.passwordHash, options.password);
    if (!ok) throw new AppError('INVALID_PASSWORD', 401, 'Incorrect password');
  }

  // Burn-after-read: authorize FIRST — failed/insufficient attempts never consume.
  if (paste.burnAfterRead) {
    const claimed = await pasteRepository.consumeBurn(paste.id);
    if (!claimed) {
      // Owner sees the 410 (it existed); strangers get the uniform 404.
      if (ctx.managementTokenVerified || (auth.kind !== 'anonymous' && auth.user.id === paste.authorId)) {
        throw AppError.gone('This paste has been consumed');
      }
      throw AppError.notFound();
    }
    return { paste, consumed: true, viaManagementToken: ctx.managementTokenVerified === true };
  }

  // max_views: synchronous exact enforcement (bypasses the buffer, §4 K).
  if (paste.maxViews !== null) {
    const counted = await pasteRepository.incrementViewGuarded(paste.id);
    if (counted === null) {
      if (ctx.managementTokenVerified || (auth.kind !== 'anonymous' && auth.user.id === paste.authorId)) {
        throw AppError.gone('Maximum view count reached');
      }
      throw AppError.notFound();
    }
    return { paste, consumed: false, viaManagementToken: ctx.managementTokenVerified === true };
  }

  if (options.countView !== false) {
    recordView(
      paste.id,
      visitorHash(options.visitorIp ?? null, options.visitorUserAgent ?? null),
    );
  }
  return { paste, consumed: false, viaManagementToken: ctx.managementTokenVerified === true };
}

/**
 * Authorization-only read path (Phase 3 revisions): full policy + password
 * gate WITHOUT burn consumption or view counting.
 */
export async function authorizePasteRead(
  idOrSlug: string,
  auth: AuthContext,
  options: GetPasteOptions = {},
): Promise<{ paste: PasteWithAuthor; ctx: PasteViewContext }> {
  const paste = await pasteRepository.findByIdOrSlug(idOrSlug);
  if (!paste) throw AppError.notFound();
  const ctx = await buildViewContext(paste.id, auth, options);
  const decision = authorizePasteView(paste, ctx);
  if (decision.outcome === 'NOT_FOUND') throw AppError.notFound();
  if (decision.outcome === 'PASSWORD_REQUIRED') {
    if (!options.password) {
      throw new AppError('PASSWORD_REQUIRED', 401, 'This paste is password-protected');
    }
    const ok = await verifyPastePassword(paste.passwordHash, options.password);
    if (!ok) throw new AppError('INVALID_PASSWORD', 401, 'Incorrect password');
  }
  return { paste, ctx };
}

/** Verifies SHARE/MANAGEMENT bearer tokens against PostgreSQL hashes. */
export async function buildViewContext(
  pasteId: string,
  auth: AuthContext,
  options: GetPasteOptions,
): Promise<PasteViewContext> {
  const ctx: PasteViewContext = { auth };

  if (options.shareToken) {
    const found = await pasteTokenRepository.findUsableByHash(hashToken(options.shareToken), 'SHARE');
    if (found && found.pasteId === pasteId) {
      ctx.shareTokenVerified = true;
      void pasteTokenRepository.incrementUse(found.id).catch(() => undefined);
    }
  }
  if (options.managementToken) {
    const found = await pasteTokenRepository.findUsableByHash(hashToken(options.managementToken), 'MANAGEMENT');
    if (found && found.pasteId === pasteId) {
      ctx.managementTokenVerified = true;
    }
  }
  return ctx;
}

export async function requireManageable(idOrSlug: string, auth: AuthContext, managementToken?: string): Promise<PasteWithAuthor> {
  const paste = await pasteRepository.findByIdOrSlug(idOrSlug);
  if (!paste) throw AppError.notFound();
  const ctx: PasteViewContext = { auth };
  if (managementToken) {
    const found = await pasteTokenRepository.findUsableByHash(hashToken(managementToken), 'MANAGEMENT');
    if (found && found.pasteId === paste.id) ctx.managementTokenVerified = true;
  }
  if (!authorizePasteManage(paste, ctx)) throw AppError.notFound(); // uniform anti-enumeration (§20.2)
  return paste;
}

export async function updatePaste(
  idOrSlug: string,
  body: UpdatePasteBody,
  auth: AuthContext,
  managementToken?: string,
): Promise<PasteWithAuthor> {
  const paste = await requireManageable(idOrSlug, auth, managementToken);

  const newExpiry = resolveExpiry(body);
  const contentChanged = body.content !== undefined && sha256Hex(body.content) !== paste.contentHash;
  if (contentChanged) assertByteLimit(body.content!);

  const passwordHash =
    body.password === undefined ? undefined : body.password === null ? null : await hashPastePassword(body.password);

  const updated = await prisma.$transaction(async (tx) => {
    let latestRevisionNo = paste.latestRevisionNo;
    if (contentChanged) {
      const nextNo = latestRevisionNo + 1;
      await pasteRepository.createRevision(
        {
          pasteId: paste.id,
          revisionNo: nextNo,
          title: body.title ?? paste.title,
          description: body.description ?? paste.description,
          language: body.language ?? paste.language,
          content: body.content!,
          contentSize: Buffer.byteLength(body.content!, 'utf8'),
          editorId: auth.kind === 'anonymous' ? null : auth.user.id,
        },
        tx,
      );
      latestRevisionNo = nextNo;
      // Cap: drop the oldest revision beyond the limit (documented §4 E).
      if (nextNo > MAX_REVISIONS_PER_PASTE) {
        await pasteRepository.deleteRevision(paste.id, nextNo - MAX_REVISIONS_PER_PASTE, tx);
      }
    }

    return pasteRepository.update(
      paste.id,
      {
        ...(contentChanged
          ? {
              content: body.content!,
              contentSize: Buffer.byteLength(body.content!, 'utf8'),
              contentHash: sha256Hex(body.content!),
              latestRevisionNo,
            }
          : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
        ...(body.visibility !== undefined
          ? { visibility: body.visibility.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE' }
          : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
        ...(newExpiry !== undefined ? { expiresAt: newExpiry } : {}),
        ...(body.maxViews !== undefined ? { maxViews: body.maxViews } : {}),
        ...(body.burnAfterRead !== undefined ? { burnAfterRead: body.burnAfterRead } : {}),
      },
      tx,
    );
  });

  if (contentChanged) {
    await adjustStorage(
      paste.authorId,
      Buffer.byteLength(body.content!, 'utf8') - paste.contentSize,
    );
  }

  // Re-schedule the expire job (deterministic jobId replaces the old one).
  if (newExpiry !== undefined) {
    void cancelPasteExpiration(paste.id).catch(() => undefined);
    if (updated.expiresAt) {
      void schedulePasteExpiration(paste.id, updated.expiresAt).catch(() => undefined);
    }
  }
  const fresh = await pasteRepository.findByIdOrSlug(paste.id);
  return fresh ?? (updated as PasteWithAuthor);
}

export async function deletePaste(
  idOrSlug: string,
  auth: AuthContext,
  managementToken?: string,
  deletedBy: 'USER' | 'MODERATOR' = 'USER',
): Promise<void> {
  const paste = await requireManageable(idOrSlug, auth, managementToken);

  const count = await pasteRepository.softDelete(paste.id, deletedBy);
  if (count > 0) {
    await adjustStorage(paste.authorId, -paste.contentSize);
    // The management credential dies with the paste (§4 B).
    await pasteTokenRepository.deleteAllForPaste(paste.id);
    void getRedis().del(REDIS_KEYS.mgmtCache(paste.id)).catch(() => undefined);
    void cancelPasteExpiration(paste.id).catch(() => undefined);
    const retentionDays =
      deletedBy === 'USER' ? TOMBSTONE_RETENTION_DAYS.USER : TOMBSTONE_RETENTION_DAYS.SYSTEM;
    void schedulePastePurge(paste.id, retentionDays * 24 * 60 * 60 * 1000).catch(() => undefined);
  }
}

export async function forkPaste(
  idOrSlug: string,
  auth: AuthContext,
  options: GetPasteOptions & { ip: string | null },
): Promise<{ paste: PasteWithAuthor; managementToken?: string }> {
  // Authorization identical to a view (password/share gates apply); the
  // source paste is never counted or consumed by a fork.
  const source = await getPasteForView(idOrSlug, auth, { ...options, countView: false });
  const sourceContent = source.paste.content;
  if (!sourceContent) throw AppError.gone('Source paste is no longer available');

  const authorId = auth.kind === 'anonymous' ? null : auth.user.id;
  if (authorId === null) await consumeAnonymousPasteQuota(options.ip);

  // Forks are fresh pastes: new id, no password, no expiry. Visibility is
  // inherited only by the owner (forking someone's private paste is impossible).
  const visibility =
    authorId !== null && authorId === source.paste.authorId ? source.paste.visibility : 'PUBLIC';

  const id = await resolvePasteId(undefined);
  const managementToken = authorId === null ? generateToken() : undefined;

  const created = await prisma.$transaction(async (tx) => {
    const paste = await pasteRepository.create(
      {
        id,
        authorId,
        title: source.paste.title,
        description: source.paste.description,
        language: source.paste.language,
        detectedLanguage: source.paste.detectedLanguage,
        content: sourceContent,
        contentSize: source.paste.contentSize,
        contentHash: source.paste.contentHash,
        visibility,
        forkOfId: source.paste.id,
      },
      tx,
    );
    await pasteRepository.createRevision(
      {
        pasteId: paste.id,
        revisionNo: 1,
        title: paste.title,
        description: paste.description,
        language: paste.language,
        content: sourceContent,
        contentSize: paste.contentSize,
        editorId: authorId,
      },
      tx,
    );
    if (managementToken) {
      await pasteTokenRepository.create(
        { pasteId: paste.id, tokenHash: hashToken(managementToken), purpose: 'MANAGEMENT', createdBy: null },
        tx,
      );
    }
    return paste;
  });

  const fresh = await pasteRepository.findByIdOrSlug(created.id);
  return { paste: fresh ?? created as PasteWithAuthor, managementToken };
}

/** Owner/author sweep: hard-deletes all pastes of a deleted account (§4 D). */
export async function hardDeleteAuthorPastes(authorId: string): Promise<void> {
  const pastes = await prisma.paste.findMany({ where: { authorId }, select: { id: true } });
  for (const paste of pastes) {
    await pasteRepository.deleteHard(paste.id);
    void getRedis().del(REDIS_KEYS.mgmtCache(paste.id)).catch(() => undefined);
    void cancelPasteExpiration(paste.id).catch(() => undefined);
  }
}

export { livePasteWhere };

export interface ShareTokenCreateBody {
  expiresAt?: string;
  maxUses?: number;
}

/** Owner-only share-token creation for private pastes (§4 B) — shown once. */
export async function createShareToken(
  idOrSlug: string,
  auth: AuthContext,
  body: ShareTokenCreateBody = {},
): Promise<{ id: string; shareToken: string; expiresAt: Date | null }> {
  const paste = await requireManageable(idOrSlug, auth);
  if (auth.kind === 'anonymous') throw AppError.unauthorized();

  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw AppError.validation('expiresAt must be a future timestamp');
  }
  const raw = generateToken();
  const created = await pasteTokenRepository.create({
    pasteId: paste.id,
    tokenHash: hashToken(raw),
    purpose: 'SHARE',
    createdBy: auth.user.id,
    expiresAt,
    maxUses: body.maxUses ?? null,
  });
  return { id: created.id, shareToken: raw, expiresAt };
}

export async function revokeShareToken(
  idOrSlug: string,
  tokenId: string,
  auth: AuthContext,
): Promise<void> {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  const paste = await requireManageable(idOrSlug, auth);
  const revoked = await pasteTokenRepository.revokeForOwner(paste.id, tokenId, auth.user.id);
  if (revoked === 0) throw AppError.notFound('Share token not found');
}
