import type { Request, RequestHandler, Response } from 'express';
import { sha256Hex } from '../services/hash.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

/**
 * Idempotency keys for paste creation (docs/ARCHITECTURE.md §4 H):
 * - 2xx responses are cached under the credential-scoped key for 24 h and
 *   replayed verbatim on identical retries (Idempotency-Replayed: true).
 * - Same key with a different body → 422 IDEMPOTENCY_KEY_REUSED.
 * - Concurrent same-key while in flight → 409 IDEMPOTENCY_IN_FLIGHT
 *   (SET NX lock, released on finish).
 * - 4xx/5xx are never cached → safe to retry with the same key.
 * Redis-only storage: total Redis loss degrades to "a retry may duplicate"
 * (documented, acceptable). Anonymous creation is out of scope — it has its
 * own one-time management-token credential.
 */
const REPLAY_TTL_SECONDS = 86_400;
const LOCK_TTL_SECONDS = 30;
const MUTATING = new Set(['POST', 'PUT', 'PATCH']);

export function idempotencyGuard(): RequestHandler {
  return async (req: Request, res: Response, next) => {
    if (!(req.method === 'POST' && req.path === '/pastes')) {
      next();
      return;
    }
    const rawKey = req.headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      next();
      return;
    }
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }
    if (rawKey.length < 8 || rawKey.length > 128) {
      next(AppError.validation('Idempotency-Key must be 8-128 characters'));
      return;
    }
    if (req.auth.kind === 'anonymous') {
      next();
      return;
    }

    const credential =
      req.auth.kind === 'session' ? `sess:${req.auth.user.id}` : `key:${req.auth.apiKeyId}`;
    const scopeKey = `idem:${credential}:${rawKey}`;
    const requestHash = sha256Hex(JSON.stringify(req.body ?? null));

    try {
      const redis = getRedis();
      const stored = await redis.get(scopeKey);
      if (stored) {
        const parsed = JSON.parse(stored) as { status: number; body: unknown; requestHash: string };
        if (parsed.requestHash !== requestHash) {
          next(
            new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              422,
              'This Idempotency-Key was used with a different request body',
            ),
          );
          return;
        }
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(parsed.status).json(parsed.body);
        return;
      }

      const lockKey = `${scopeKey}:lock`;
      const locked = await redis.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
      if (!locked) {
        next(
          new AppError(
            'IDEMPOTENCY_IN_FLIGHT',
            409,
            'A request with this Idempotency-Key is already in flight',
          ),
        );
        return;
      }

      let captured: { status: number; body: unknown } | null = null;
      const originalJson = res.json.bind(res);
      res.json = (payload: unknown) => {
        captured = { status: res.statusCode, body: payload };
        return originalJson(payload);
      };

      res.setHeader('Idempotency-Replayed', 'false');
      res.on('finish', () => {
        void redis.del(lockKey).catch(() => undefined);
        if (captured && res.statusCode >= 200 && res.statusCode < 300) {
          void redis
            .set(
              scopeKey,
              JSON.stringify({ status: captured.status, body: captured.body, requestHash }),
              'EX',
              REPLAY_TTL_SECONDS,
            )
            .catch(() => undefined);
        }
      });
      next();
    } catch (err) {
      // Redis unavailable → fail open (only client retries may duplicate; §4 H).
      logger.warn({ err: err instanceof Error ? err.message : err }, 'idempotency store unavailable; failing open');
      next();
    }
  };
}
