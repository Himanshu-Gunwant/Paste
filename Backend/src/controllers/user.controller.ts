import type { RequestHandler } from 'express';
import * as userService from '../services/user.service.js';
import * as discoveryService from '../services/discovery.service.js';
import type { FeedQuery } from '../validators/discovery.validators.js';
import * as sessionService from '../services/session.service.js';
import type { DeleteMeBody, UpdateMeBody } from '../validators/user.validators.js';

/** /users/me handlers — authenticated via requireAuth (session context). */
export const getMe: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') {
    // Unreachable behind requireAuth; keeps the type-narrowing honest.
    throw new Error('unreachable');
  }
  const user = await userService.getMe(req.auth.user.id);
  res.status(200).json({ user: userService.toCurrentUser(user) });
};

export const updateMe: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable');
  const body = (req.validated.body ?? {}) as UpdateMeBody;
  const user = await userService.updateMe(req.auth.user.id, body);
  res.status(200).json({ user: userService.toCurrentUser(user) });
};

export const deleteMe: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable');
  const body = (req.validated.body ?? undefined) as DeleteMeBody | undefined;
  await userService.deleteAccount(req.auth.user.id, body?.password ?? null);
  res.status(204).send();
};

function sessionView(session: {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}) {
  return {
    id: session.id,
    ip: session.ip,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
  };
}

export const listSessions: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable');
  const sessions = await sessionService.listSessions(req.auth.user.id);
  res.status(200).json({ data: sessions.map(sessionView) });
};

export const revokeSession: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable');
  const params = req.validated.params as { id: string };
  // Idempotent: revoking an unknown/already-revoked session is a no-op.
  await sessionService.revokeSessionForUser(req.auth.user.id, params.id);
  res.status(204).send();
};

export const revokeAllSessions: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable');
  const revoked = await sessionService.revokeAllSessions(req.auth.user.id);
  res.status(200).json({ revoked });
};

export const getPublicProfile: RequestHandler = async (req, res) => {
  const params = req.validated.params as { username: string };
  const profile = await userService.getPublicProfile(params.username);
  res.status(200).json({ profile });
};

/** Public pastes of a user — same database-level leak protection as the feed. */
export const getUserPublicPastes: RequestHandler = async (req, res) => {
  const params = req.validated.params as { username: string };
  const query = (req.validated.query ?? {}) as FeedQuery;
  const result = await discoveryService.listPublicPastes({
    sort: query.sort === 'trending' ? 'latest' : (query.sort ?? 'latest'),
    language: query.language,
    username: params.username,
    cursor: query.cursor,
    limit: query.limit,
  });
  res.status(200).json(result);
};
