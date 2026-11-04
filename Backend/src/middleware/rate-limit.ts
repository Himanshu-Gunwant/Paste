import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

/**
 * Redis sliding-window rate limiter (docs/ARCHITECTURE.md §4 J, §12.1).
 * Lua keeps trim+count+add atomic across app instances. Identity is
 * req.ip (trust proxy = 1 hop) by default, or caller-supplied (e.g. email
 * + IP for login). On limit hit: 429 with Retry-After; RateLimit-* headers
 * are set on every response. Redis unavailability fails OPEN with a logged
 * warning — the Nginx global limit remains as the outer guard.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = windowMs
  if oldest[2] ~= false and oldest[2] ~= nil then
    retryAfterMs = math.max(1, math.ceil(tonumber(oldest[2]) + windowMs - now))
  end
  return {0, 0, retryAfterMs}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return {1, limit - count - 1, 0}
`;

export interface RateLimitOptions {
  /** Bucket name — forms the Redis key namespace, e.g. `auth`. */
  bucket: string;
  limit: number;
  windowSeconds: number;
  /** Override the identity (defaults to req.ip). */
  identity?: (req: Request) => string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    let identity: string;
    try {
      identity = options.identity ? options.identity(req) : (req.ip ?? 'unknown');
    } catch {
      identity = 'unknown';
    }
    const key = `rl:${options.bucket}:${identity}`;
    const member = `${Date.now()}:${req.id}`;
    const windowMs = options.windowSeconds * 1000;

    try {
      const result = (await getRedis().eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        String(Date.now()),
        String(windowMs),
        String(options.limit),
        member,
      )) as [number, number, number];

      const [allowed, remaining, retryAfterMs] = result;
      const resetEpochSeconds = Math.ceil(
        (Date.now() + (allowed ? windowMs : retryAfterMs)) / 1000,
      );
      res.setHeader('RateLimit-Limit', String(options.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
      res.setHeader('RateLimit-Reset', String(resetEpochSeconds));

      if (!allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        next(AppError.tooManyRequests('Too many requests, please retry later'));
        return;
      }
      next();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, bucket: options.bucket }, 'rate limiter unavailable; failing open');
      next();
    }
  };
}
