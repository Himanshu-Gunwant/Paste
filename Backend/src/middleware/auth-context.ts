import type { RequestHandler } from 'express';
import { SESSION_COOKIE } from '../config/constants.js';
import { getCookie } from '../lib/cookies.js';
import { ANONYMOUS, type AuthContext } from '../types/auth.js';
import { resolveSession } from '../services/session.service.js';

/**
 * Resolves the request's authentication context (docs/ARCHITECTURE.md §7.1):
 * Authorization: Bearer → API key (Phase 5); __Host-sess cookie → session;
 * otherwise anonymous. ALWAYS sets req.auth — services decide authorization.
 * Invalid/expired credentials degrade to anonymous here; 401 is raised by
 * requireAuth, so public endpoints work uniformly for all viewer kinds.
 */
export function authContext(): RequestHandler {
  return async (req, _res, next) => {
    req.validated = {};

    let auth: AuthContext = ANONYMOUS;

    const sessionToken = getCookie(req.headers.cookie, SESSION_COOKIE);
    if (sessionToken) {
      const resolved = await resolveSession(sessionToken);
      if (resolved) {
        auth = {
          kind: 'session',
          sessionId: resolved.session.id,
          user: resolved.user,
        };
      }
    }

    req.auth = auth;
    next();
  };
}
