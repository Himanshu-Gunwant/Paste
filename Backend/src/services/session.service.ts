import { SESSION_IDLE_DAYS, SESSION_TOUCH_THRESHOLD_HOURS } from '../config/constants.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { sessionRepository, type SessionWithUser } from '../repositories/session.repository.js';
import { userRepository } from '../repositories/user.repository.js';

const SESSION_IDLE_MS = SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
const TOUCH_THRESHOLD_MS = SESSION_TOUCH_THRESHOLD_HOURS * 60 * 60 * 1000;

/**
 * Session lifecycle (docs/ARCHITECTURE.md §4 D): 32-byte CSPRNG token in an
 * httpOnly __Host-sess cookie; only its SHA-256 hash is stored, as the PK.
 * Rolling 30-day idle expiry; the DB row is rewritten at most once per hour
 * to keep the hot path read-only.
 */
export async function createSession(input: {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; session: SessionWithUser }> {
  const token = generateToken();
  const session = await sessionRepository.create({
    id: hashToken(token),
    userId: input.userId,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 255) ?? null,
    expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
  });
  const user = await userRepository.findById(session.userId);
  if (!user) throw new Error(`session referenced missing user ${session.userId}`);
  return { token, session: { ...session, user } };
}

/**
 * Resolves a raw session token to its session + user, enforcing expiry and
 * an ACTIVE, non-deleted account. Expired rows are cleaned up opportunistically.
 */
export async function resolveSession(
  token: string,
): Promise<{ session: SessionWithUser; user: SessionWithUser['user'] } | null> {
  const session = await sessionRepository.findWithUser(hashToken(token));
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    void sessionRepository.delete(session.id).catch(() => undefined);
    return null;
  }
  if (session.user.status !== 'ACTIVE' || session.user.deletedAt !== null) return null;

  if (now - session.lastUsedAt.getTime() > TOUCH_THRESHOLD_MS) {
    void sessionRepository
      .touch(session.id, new Date(now + SESSION_IDLE_MS))
      .catch(() => undefined);
  }

  return { session, user: session.user };
}

/** Logout (idempotent — unknown tokens are a no-op). */
export async function revokeSessionByToken(token: string): Promise<void> {
  await sessionRepository.delete(hashToken(token)).catch(() => undefined);
}

export async function revokeSessionForUser(userId: string, sessionId: string): Promise<boolean> {
  const count = await sessionRepository.deleteIfOwnedBy(userId, sessionId);
  return count > 0;
}

export async function revokeAllSessions(userId: string): Promise<number> {
  return sessionRepository.deleteAllForUser(userId);
}

export function listSessions(userId: string) {
  return sessionRepository.listForUser(userId);
}
