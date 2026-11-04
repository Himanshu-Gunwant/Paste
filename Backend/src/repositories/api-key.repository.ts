import { prisma } from '../lib/prisma.js';
import type { ApiKey, User } from '../generated/prisma/client.js';

export type ApiKeyWithUser = ApiKey & { user: User };

/** API key persistence — hashes are authoritative; raw keys shown once. */
export const apiKeyRepository = {
  create(data: {
    userId: string;
    name: string;
    prefix: string;
    keyHash: string;
    expiresAt?: Date | null;
  }): Promise<ApiKey> {
    return prisma.apiKey.create({ data });
  },

  findUsableByHash(keyHash: string): Promise<ApiKeyWithUser | null> {
    return prisma.apiKey.findFirst({
      where: {
        keyHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { user: true },
    });
  },

  listForUser(userId: string): Promise<ApiKey[]> {
    return prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  },

  revokeForOwner(id: string, userId: string): Promise<number> {
    return prisma.apiKey
      .updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } })
      .then((r) => r.count);
  },

  touch(id: string): Promise<void> {
    return prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }).then(() => undefined);
  },
};
