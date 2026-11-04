import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger.js';

/**
 * Request logging + correlation id middleware (docs/ARCHITECTURE.md §16).
 * - Honors an inbound X-Request-Id (capped length) or mints a UUID; always
 *   echoes it as a response header and stores it on req.id for the error
 *   envelope and queue job propagation.
 * - Never logs request bodies; auth material is redacted at the logger level.
 * - Suppresses per-request logging for the liveness probe to avoid noise.
 */
export function requestLogging() {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 64
          ? incoming
          : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: {
      ignore: (req) => req.url === '/healthz',
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[REDACTED]',
    },
  });
}
