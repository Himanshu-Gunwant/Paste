import type { RequestHandler } from 'express';
import { isIpBanned } from '../services/admin.service.js';
import { AppError } from '../lib/errors.js';

/**
 * IP-ban guard for ANONYMOUS write paths (docs/ARCHITECTURE.md §4 J):
 * paste creation + abuse reports. Authenticated requests are covered by
 * account-level restrictions instead.
 */
export function ipBanGuard(): RequestHandler {
  return async (req, _res, next) => {
    if (req.auth.kind !== 'anonymous') {
      next();
      return;
    }
    try {
      if (await isIpBanned(req.ip ?? null)) {
        next(AppError.forbidden('This network is not allowed to perform this action'));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
