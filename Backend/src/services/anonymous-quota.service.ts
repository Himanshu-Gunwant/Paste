import { ANON_DAILY_PASTE_QUOTA, REDIS_KEYS, utcDateKey } from '../config/constants.js';
import { AppError } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';

/**
 * Anonymous per-IP daily creation quota (docs/ARCHITECTURE.md §4 J).
 * Redis counter keyed by IP + UTC day with a 48 h self-expiring TTL —
 * no cron, no DB. Fails open on Redis outage (rate limiter still guards).
 */
export async function consumeAnonymousPasteQuota(ip: string | null): Promise<void> {
  const identity = ip ?? 'unknown';
  try {
    const redis = getRedis();
    const key = REDIS_KEYS.anonQuota(identity, utcDateKey());
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 48 * 60 * 60).catch(() => undefined);
    }
    if (count > ANON_DAILY_PASTE_QUOTA) {
      throw AppError.quotaExceeded('Daily anonymous paste limit reached');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis unavailable → fail open with a warning.
    console.error('anonymous quota check unavailable; failing open', err);
  }
}
