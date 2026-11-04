import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Shared Redis connection settings.
 *
 * - `maxRetriesPerRequest: null` is REQUIRED by BullMQ (commands wait out
 *   reconnects instead of failing fast).
 * - `lazyConnect: true` keeps import of this module side-effect free (unit
 *   tests, app assembly) — the connection opens on first command.
 * - `noeviction` is the server-side policy (docker-compose mirrors prod);
 *   queue payloads and view deltas must never be evicted.
 */
export const redisConnectionOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
} as const;

let instance: Redis | null = null;

/** Lazy singleton for general app use (health checks, Phase 2+ rate limits). */
export function getRedis(): Redis {
  if (!instance) {
    instance = new Redis(env.REDIS_URL, redisConnectionOptions);
    // Without this listener a connection failure crashes the process.
    instance.on('error', (err) => {
      logger.error({ err: err.message }, 'redis connection error');
    });
  }
  return instance;
}

export async function closeRedis(): Promise<void> {
  if (!instance) return;
  const conn = instance;
  instance = null;
  try {
    await conn.quit();
  } catch {
    conn.disconnect();
  }
}
