import { prisma } from '../lib/prisma.js';
import type { Session, User } from '../generated/prisma/client.js';

export type SessionWithUser = Session & { user: User };

/** All Session persistence goes through this repository. */
export const sessionRepository = {
  create(data: {
    id: string;
    userId: string;
    ip: string | null;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<Session> {
    return prisma.session.create({ data });
  },

  /** PK is the token hash — single indexed lookup per authenticated request. */
  findWithUser(id: string): Promise<SessionWithUser | null> {
    return prisma.session.findUnique({ where: { id }, include: { user: true } });
  },

  /** Rolling idle expiry; throttled by the service layer (§4 D). */
  touch(id: string, expiresAt: Date): Promise<Session> {
    return prisma.session.update({
      where: { id },
      data: { lastUsedAt: new Date(), expiresAt },
    });
  },

  delete(id: string): Promise<Session> {
    return prisma.session.delete({ where: { id } });
  },

  deleteIfOwnedBy(userId: string, id: string): Promise<number> {
    return prisma.session.deleteMany({ where: { id, userId } }).then((r) => r.count);
  },

  deleteAllForUser(userId: string): Promise<number> {
    return prisma.session.deleteMany({ where: { userId } }).then((r) => r.count);
  },

  listForUser(userId: string): Promise<Session[]> {
    return prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
  },
};
