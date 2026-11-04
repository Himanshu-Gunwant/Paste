import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { UserRole } from '../generated/prisma/client.js';

export interface RequireAuthOptions {
  /** Require at least this role (e.g. admin-only routes). */
  role?: Extract<UserRole, 'ADMIN'>;
}

/**
 * Route guard: rejects anonymous requests (optionally requires ADMIN).
 * Per-resource authorization (ownership, visibility) stays in services —
 * this guard only answers "is there an authenticated principal of role X".
 */
export function requireAuth(options: RequireAuthOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (auth.kind === 'anonymous') {
      next(AppError.unauthorized());
      return;
    }
    if (options.role && auth.user.role !== options.role) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}
