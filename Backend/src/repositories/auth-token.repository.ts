import { prisma } from '../lib/prisma.js';
import type { AuthTokenType, AuthToken, User } from '../generated/prisma/client.js';

export type AuthTokenWithUser = AuthToken & { user: User };

/** Single-use hashed auth tokens (email verification / password reset). */
export const authTokenRepository = {
  create(data: {
    id: string;
    userId: string;
    type: AuthTokenType;
    expiresAt: Date;
  }): Promise<AuthToken> {
    return prisma.authToken.create({ data });
  },

  /** Unused + unexpired only; includes the user for downstream checks. */
  findUsableWithUser(id: string, type: AuthTokenType): Promise<AuthTokenWithUser | null> {
    return prisma.authToken.findFirst({
      where: { id, type, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
  },

  /** Conditional consume — returns 0 when another request won the race. */
  consume(id: string): Promise<number> {
    return prisma.authToken
      .updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })
      .then((r) => r.count);
  },

  deleteAllForUser(userId: string, type?: AuthTokenType): Promise<number> {
    return prisma.authToken
      .deleteMany({ where: { userId, ...(type ? { type } : {}) } })
      .then((r) => r.count);
  },

  /** Maintenance sweep (§12.3): drop expired or fully-consumed tokens. */
  deleteExpiredBefore(date: Date): Promise<number> {
    return prisma.authToken
      .deleteMany({ where: { OR: [{ expiresAt: { lt: date } }, { usedAt: { not: null } }] } })
      .then((r) => r.count);
  },
};
