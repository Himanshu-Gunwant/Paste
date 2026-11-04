import { createHmac } from 'node:crypto';
import { REDIS_KEYS, utcDateKey } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { pasteRepository } from '../repositories/paste.repository.js';

/**
 * View counting (docs/ARCHITECTURE.md §12.1–12.2): Redis-buffered, flushed
 * exactly-once with crash recovery. Exactly-once semantics:
 *   1. Recovery pass applies any `views:inflight:*` keys left by crashed runs.
 *   2. Fresh deltas are claimed atomically via RENAME delta → inflight
 *      (a concurrent flush can never double-claim), applied, then deleted.
 * Accepted loss: ≤ one flush window (60 s) on catastrophic Redis failure;
 * zero double-counting. max_views/burn pastes bypass buffering entirely.
 */
const VIEW_HASH_SECRET = env.SESSION_SECRET ?? 'dev-insecure-view-hash-secret';

export function visitorHash(ip: string | null, userAgent: string | null): string {
  return createHmac('sha256', VIEW_HASH_SECRET)
    .update(`${ip ?? ''}|${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/** Fire-and-forget buffer write — NEVER blocks or fails the response. */
export function recordView(pasteId: string, vHash: string): void {
  const redis = getRedis();
  void redis
    .pipeline()
    .incr(REDIS_KEYS.viewDelta(pasteId))
    .pfadd(REDIS_KEYS.uv(pasteId, utcDateKey()), vHash)
    .expire(REDIS_KEYS.uv(pasteId, utcDateKey()), 7 * 24 * 60 * 60)
    .exec()
    .catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, pasteId }, 'view buffer write failed');
    });
}

function dayStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Applies one buffered delta to view_count + paste_view_daily atomically. */
async function applyDelta(pasteId: string, rawDelta: string): Promise<void> {
  const delta = BigInt(rawDelta);
  if (delta <= 0n) return;
  try {
    await prisma.$transaction(async (tx) => {
      await pasteRepository.incrementViewCount(pasteId, delta, tx);
      await pasteRepository.viewDailyIncrement(pasteId, dayStartUtc(), delta, tx);
    });
  } catch (err) {
    // Paste purged between buffer and flush → drop the orphaned delta.
    logger.warn({ err: err instanceof Error ? err.message : err, pasteId }, 'view flush target missing; delta dropped');
  }
}

async function scanKeys(match: string): Promise<string[]> {
  const redis = getRedis();
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

export interface FlushResult {
  recovered: number;
  applied: number;
  totalViews: number;
}

export async function flushViewDeltas(runId: string): Promise<FlushResult> {
  const redis = getRedis();
  let recovered = 0;
  let applied = 0;
  let totalViews = 0;

  // 1) Recovery: apply deltas claimed by a crashed flush, then free the keys.
  const inflightKeys = await scanKeys('views:inflight:*');
  for (const key of inflightKeys) {
    const raw = await redis.get(key);
    await redis.del(key);
    if (!raw) continue;
    const pasteId = key.slice('views:inflight:'.length, key.lastIndexOf(':'));
    await applyDelta(pasteId, raw);
    recovered += 1;
    totalViews += Number(raw);
  }

  // 2) Claim fresh deltas atomically: RENAME delta → inflight(this run).
  const deltaKeys = await scanKeys('views:delta:*');
  for (const key of deltaKeys) {
    const pasteId = key.slice('views:delta:'.length);
    const runKey = REDIS_KEYS.viewInflight(pasteId, runId);
    try {
      await redis.rename(key, runKey);
    } catch {
      continue; // another flush claimed it first (ENOENT) — exactly-once holds
    }
    const raw = await redis.get(runKey);
    await redis.del(runKey);
    if (!raw) continue;
    await applyDelta(pasteId, raw);
    applied += 1;
    totalViews += Number(raw);
  }

  return { recovered, applied, totalViews };
}

/** Hourly HLL flush: approximate unique visitors, monotonic per day (§12.2). */
export async function flushUniqueVisitors(): Promise<number> {
  const redis = getRedis();
  const keys = await scanKeys('uv:*');
  let processed = 0;
  for (const key of keys) {
    const rest = key.slice('uv:'.length);
    const pasteId = rest.slice(0, rest.lastIndexOf(':'));
    const dateStr = rest.slice(rest.lastIndexOf(':') + 1);
    if (!pasteId || !/^\d{8}$/.test(dateStr)) continue;

    const count = await redis.pfcount(key);
    const day = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00Z`);
    try {
      const existing = await prisma.pasteViewDaily.findUnique({
        where: { pasteId_day: { pasteId, day } },
        select: { uniqueVisitors: true },
      });
      const current = existing?.uniqueVisitors ?? 0n;
      if (BigInt(count) > current) {
        await prisma.pasteViewDaily.upsert({
          where: { pasteId_day: { pasteId, day } },
          create: { pasteId, day, uniqueVisitors: BigInt(count) },
          update: { uniqueVisitors: BigInt(count) },
        });
      }
      await redis.del(key);
      processed += 1;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, pasteId }, 'HLL flush target missing');
    }
  }
  return processed;
}
