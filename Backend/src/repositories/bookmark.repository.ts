import { prisma } from '../lib/prisma.js';
import type { Bookmark, Paste } from '../generated/prisma/client.js';

export type BookmarkWithPaste = Bookmark & { paste: Paste };

/** Personal read-later list — always private (docs/ARCHITECTURE.md §4 F). */
export const bookmarkRepository = {
  /** Idempotent PUT — create-or-ignore on the composite PK. */
  async add(userId: string, pasteId: string): Promise<void> {
    await prisma.bookmark.upsert({
      where: { userId_pasteId: { userId, pasteId } },
      create: { userId, pasteId },
      update: {},
    });
  },

  remove(userId: string, pasteId: string): Promise<number> {
    return prisma.bookmark.deleteMany({ where: { userId, pasteId } }).then((r) => r.count);
  },

  listForUser(userId: string): Promise<BookmarkWithPaste[]> {
    return prisma.bookmark.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { paste: true },
    });
  },
};
