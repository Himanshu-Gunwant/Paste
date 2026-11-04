import type { Request, RequestHandler, Response } from 'express';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_IDLE_DAYS,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { getCookie } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import * as authService from '../services/auth.service.js';
import * as oauthService from '../services/oauth.service.js';
import { toCurrentUser } from '../services/user.service.js';
import type {
  LoginBody,
  PasswordResetConfirmBody,
  PasswordResetRequestBody,
  RegisterBody,
  VerifyEmailConfirmBody,
} from '../validators/auth.validators.js';

/**
 * Auth HTTP adapters — parse nothing, decide nothing: validators shape the
 * input, services own every rule (docs/ARCHITECTURE.md §14). Controllers set
 * the session cookie (httpOnly, SameSite=Lax, __Host- prefix, Secure in prod).
 */
function cookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function clientInput(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export const register: RequestHandler = async (req, res) => {
  const body = req.validated.body as RegisterBody;
  const { user, sessionToken } = await authService.register({ ...body, ...clientInput(req) });
  setSessionCookie(res, sessionToken);
  res.status(201).json({ user: toCurrentUser(user) });
};

export const login: RequestHandler = async (req, res) => {
  const body = req.validated.body as LoginBody;
  const { user, sessionToken } = await authService.login({ ...body, ...clientInput(req) });
  setSessionCookie(res, sessionToken);
  res.status(200).json({ user: toCurrentUser(user) });
};

export const logout: RequestHandler = async (req, res) => {
  const token = getCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) await authService.logout(token);
  clearSessionCookie(res);
  res.status(204).send();
};

export const requestEmailVerification: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw AppError.unauthorized();
  await authService.sendEmailVerificationForUser(req.auth.user);
  res.status(202).json({ status: 'accepted' });
};

export const confirmPasswordVerification: RequestHandler = async (req, res) => {
  const body = req.validated.body as VerifyEmailConfirmBody;
  const user = await authService.confirmEmailVerification(body.token);
  res.status(200).json({ status: 'ok', emailVerified: user.emailVerified });
};

/** Email-link variant: consumes the token and redirects to the frontend. */
export const verifyEmailRedirect: RequestHandler = async (req, res) => {
  const query = req.validated.query as VerifyEmailConfirmBody;
  const frontend = env.FRONTEND_ORIGIN ?? env.APP_BASE_URL;
  try {
    await authService.confirmEmailVerification(query.token);
    res.redirect(302, `${frontend}/verified?status=success`);
  } catch {
    res.redirect(302, `${frontend}/verified?status=error`);
  }
};

export const requestPasswordReset: RequestHandler = async (req, res) => {
  const body = req.validated.body as PasswordResetRequestBody;
  // Always 202 — never reveals whether the email exists (anti-enumeration).
  await authService.requestPasswordReset(body.email);
  res.status(202).json({ status: 'accepted' });
};

export const confirmPasswordReset: RequestHandler = async (req, res) => {
  const body = req.validated.body as PasswordResetConfirmBody;
  await authService.confirmPasswordReset(body.token, body.newPassword);
  res.status(204).send();
};

export const oauthStart: RequestHandler = (req, res) => {
  const raw = req.params['provider'];
  const provider = typeof raw === 'string' ? raw : '';
  if (!oauthService.isOAuthProvider(provider)) throw AppError.notFound('Unknown OAuth provider');

  const started = oauthService.start(provider);
  res.cookie(
    OAUTH_STATE_COOKIE,
    JSON.stringify(started.stateCookie),
    cookieOptions(started.stateCookieMaxAgeSeconds * 1000),
  );
  res.redirect(302, started.authorizeUrl);
};

export const oauthCallback: RequestHandler = async (req, res) => {
  const rawProvider = req.params['provider'];
  const provider = typeof rawProvider === 'string' ? rawProvider : '';
  const frontend = env.FRONTEND_ORIGIN ?? env.APP_BASE_URL;
  res.clearCookie(OAUTH_STATE_COOKIE, cookieOptions());

  if (!oauthService.isOAuthProvider(provider)) {
    res.redirect(302, `${frontend}/login?oauth=unknown_provider`);
    return;
  }

  let stateCookie: oauthService.OAuthStateCookie | undefined;
  const rawStateCookie = getCookie(req.headers.cookie, OAUTH_STATE_COOKIE);
  if (rawStateCookie) {
    try {
      const parsed: unknown = JSON.parse(rawStateCookie);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { state?: unknown }).state === 'string') {
        stateCookie = parsed as oauthService.OAuthStateCookie;
      }
    } catch {
      stateCookie = undefined;
    }
  }

  try {
    const currentUserId =
      req.auth.kind === 'session' ? req.auth.user.id : undefined;

    const result = await oauthService.handleCallback({
      provider,
      code: typeof req.query['code'] === 'string' ? req.query['code'] : undefined,
      state: typeof req.query['state'] === 'string' ? req.query['state'] : undefined,
      providerError: typeof req.query['error'] === 'string' ? req.query['error'] : undefined,
      stateCookie,
      currentUserId,
      ...clientInput(req),
    });

    setSessionCookie(res, result.sessionToken);
    const status = result.created ? 'created' : result.linked ? 'linked' : 'login';
    res.redirect(302, `${frontend}/auth/callback?status=${status}`);
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    res.redirect(302, `${frontend}/login?oauth=error&reason=${encodeURIComponent(code)}`);
  }
};
