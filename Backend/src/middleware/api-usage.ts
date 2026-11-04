import type { Request, RequestHandler, Response } from 'express';
import { recordApiUsage } from '../services/api-usage.service.js';
import { consumeApiKeyQuota } from '../services/api-key.service.js';

/**
 * API-key request pipeline (docs/ARCHITECTURE.md §4 H): daily quota gate,
 * then usage capture on response finish (buffered, never blocking).
 */
export function apiKeyQuota(): RequestHandler {
  return async (req, _res, next) => {
    if (req.auth.kind !== 'apiKey') {
      next();
      return;
    }
    try {
      await consumeApiKeyQuota(req.auth.apiKeyId);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function apiUsageRecorder(): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (req.auth.kind !== 'apiKey') {
      next();
      return;
    }
    const apiKeyId = req.auth.apiKeyId;
    const userId = req.auth.user.id;
    const started = Date.now();
    res.on('finish', () => {
      const routePath = req.baseUrl + (req.route?.path ?? req.path);
      recordApiUsage({
        apiKeyId,
        userId,
        endpoint: routePath.slice(0, 120),
        method: req.method.slice(0, 8),
        statusCode: res.statusCode,
        latencyMs: Math.min(Date.now() - started, 2_147_483_647),
      });
    });
    next();
  };
}
