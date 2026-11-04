import type { Prisma } from '../generated/prisma/client.js';
import type { Paste, PasteToken, TokenPurpose } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';

type Db = Prisma.TransactionClient;

/** Paste-scoped bearer tokens: MANAGEMENT (anon owner) and SHARE (private). */
export const pasteTokenRepository = {
  create(
    data: {
      pasteId: string;
      tokenHash: string;
      purpose: TokenPurpose;
      createdBy?: string | null;
      expiresAt?: Date | null;
      maxUses?: number | null;
    },
    db: Db = prisma,
  ): Promise<PasteToken> {
    return db.pasteToken.create({ data });
  },

  findUsableByHash(
    tokenHash: string,
    purpose: TokenPurpose,
  ): Promise<(PasteToken & { paste: Paste }) | null> {
    return prisma.pasteToken.findFirst({
      where: {
        tokenHash,
        purpose,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { paste: true },
    });
  },

  findForPaste(pasteId: string, purpose: TokenPurpose): Promise<PasteToken | null> {
    return prisma.pasteToken.findFirst({
      where: { pasteId, purpose, revokedAt: null },
    });
  },

  incrementUse(id: string, db: Db = prisma): Promise<PasteToken> {
    return db.pasteToken.update({ where: { id }, data: { useCount: { increment: 1 } } });
  },

  /** Owner-scoped share-token revocation (paste author check in the where). */
  revokeForOwner(pasteId: string, tokenId: string, ownerId: string): Promise<number> {
    return prisma.pasteToken
      .updateMany({
        where: { id: tokenId, pasteId, revokedAt: null, paste: { authorId: ownerId } },
        data: { revokedAt: new Date() },
      })
      .then((r) => r.count);
  },

  /** Paste deletion invalidates all its tokens (management credential dies with the paste). */
  deleteAllForPaste(pasteId: string, db: Db = prisma): Promise<number> {
    return db.pasteToken.deleteMany({ where: { pasteId } }).then((r) => r.count);
  },
};
