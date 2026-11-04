import { prisma } from '../lib/prisma.js';
import type { OAuthAccount, OAuthProvider, User } from '../generated/prisma/client.js';

export type OAuthAccountWithUser = OAuthAccount & { user: User };

/** Provider identities linked to local accounts (docs/ARCHITECTURE.md §4 D). */
export const oauthAccountRepository = {
  findByIdentity(provider: OAuthProvider, providerAccountId: string): Promise<OAuthAccount | null> {
    return prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
    });
  },

  create(data: { userId: string; provider: OAuthProvider; providerAccountId: string }): Promise<OAuthAccount> {
    return prisma.oAuthAccount.create({ data });
  },
};
