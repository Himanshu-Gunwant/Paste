import { API_DAILY_QUOTA } from '../config/constants.js';
import { AppError } from '../lib/errors.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { apiKeyRepository, type ApiKeyWithUser } from '../repositories/api-key.repository.js';
import { getRedis } from '../lib/redis.js';
import { utcDateKey } from '../config/constants.js';
import type { ApiKey, User } from '../generated/prisma/client.js';

/**
 * Developer API keys (docs/ARCHITECTURE.md §4 H): `pb_`-prefixed 256-bit
 * keys, SHA-256 hashed at rest, shown exactly once, revoke-only lifecycle.
 * Keys inherit their owner's authorization, never admin, and are blocked
 * when the owner is suspended, deleted or email-unverified.
 */

export function formatApiKey(): { raw: string; prefix: string; keyHash: string } {
  const raw = `pb_${generateToken(32)}`;
  return { raw, prefix: raw.slice(0, 12), keyHash: hashToken(raw) };
}

export async function createApiKey(
  user: User,
  input: { name: string; expiresAt?: Date | null },
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  const { raw, prefix, keyHash } = formatApiKey();
  const apiKey = await apiKeyRepository.create({
    userId: user.id,
    name: input.name,
    prefix,
    keyHash,
    expiresAt: input.expiresAt ?? null,
  });
  return { apiKey, rawKey: raw };
}

export function listApiKeys(userId: string): Promise<ApiKey[]> {
  return apiKeyRepository.listForUser(userId);
}

export async function revokeApiKey(userId: string, id: string): Promise<void> {
  const count = await apiKeyRepository.revokeForOwner(id, userId);
  if (count === 0) throw AppError.notFound('API key not found');
}

const TOUCH_THRESHOLD_MS = 5 * 60 * 1000;

/** Bearer resolution — owner must be ACTIVE, non-deleted and email-verified. */
export async function resolveApiKey(
  raw: string,
): Promise<{ apiKey: ApiKeyWithUser; user: ApiKeyWithUser['user'] } | null> {
  const found = await apiKeyRepository.findUsableByHash(hashToken(raw));
  if (!found) return null;
  const { user } = found;
  if (user.status !== 'ACTIVE' || user.deletedAt || !user.emailVerified) return null;

  const lastUsed = found.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - lastUsed > TOUCH_THRESHOLD_MS) {
    void apiKeyRepository.touch(found.id).catch(() => undefined);
  }
  return { apiKey: found, user };
}

/** Daily per-key request quota — self-expiring Redis counter (§4 H). */
export async function consumeApiKeyQuota(apiKeyId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = `apiq:${apiKeyId}:${utcDateKey()}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 48 * 60 * 60).catch(() => undefined);
    if (count > API_DAILY_QUOTA) {
      throw AppError.quotaExceeded('Daily API quota exceeded');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis unavailable → fail open (Nginx limits remain).
  }
}
