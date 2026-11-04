import type { Request, RequestHandler } from 'express';
import { getCookie } from '../lib/cookies.js';
import { SESSION_COOKIE } from '../config/constants.js';
import { AppError } from '../lib/errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF guard via Origin validation (docs/ARCHITECTURE.md §13).
 * Applies ONLY to state-changing requests that carry our session cookie —
 * Bearer-token API clients are CSRF-immune by construction, and requests
 * without an Origin header (curl/CLI) cannot originate a cross-site form
 * post. Presence of the header with a disallowed value is rejected.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  return (req: Request, _res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    if (!getCookie(req.headers.cookie, SESSION_COOKIE)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (allowedOrigins.includes(origin)) {
      next();
      return;
    }
    next(AppError.forbidden('Cross-origin request rejected'));
  };
}
