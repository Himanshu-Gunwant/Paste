import type { Prisma } from '../generated/prisma/client.js';
import type { Collection, Paste } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';

type Db = Prisma.TransactionClient;

export type CollectionWithOwner = Collection & { owner: { username: string } };

/** Collections + ordered membership (docs/ARCHITECTURE.md §4 F). */
export const collectionRepository = {
  create(
    data: {
      ownerId: string;
      slug: string;
      title: string;
      description?: string | null;
      visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
    },
    db: Db = prisma,
  ): Promise<Collection> {
    return db.collection.create({ data });
  },

  findById(id: string): Promise<Collection | null> {
    return prisma.collection.findUnique({ where: { id } });
  },

  findByIdWithOwner(id: string): Promise<CollectionWithOwner | null> {
    return prisma.collection.findUnique({
      where: { id },
      include: { owner: { select: { username: true } } },
    });
  },

  /** Owner-scoped uniqueness target — used for conflict detection. */
  findByOwnerAndSlug(ownerId: string, slug: string): Promise<Collection | null> {
    return prisma.collection.findUnique({ where: { ownerId_slug: { ownerId, slug } } });
  },

  listForOwner(ownerId: string): Promise<(Collection & { owner: { username: string }; _count: { pastes: number } })[]> {
    return prisma.collection.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { username: true } }, _count: { select: { pastes: true } } },
    });
  },

  listPublicByUsername(username: string): Promise<(Collection & { owner: { username: string } })[]> {
    return prisma.collection.findMany({
      where: {
        visibility: 'PUBLIC',
        owner: { username, status: 'ACTIVE', deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { username: true } } },
    });
  },

  update(id: string, patch: { title?: string; description?: string | null; slug?: string; visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' }, db: Db = prisma): Promise<Collection> {
    return db.collection.update({ where: { id }, data: patch });
  },

  delete(id: string, db: Db = prisma): Promise<void> {
    return db.collection.delete({ where: { id } }).then(() => undefined);
  },

  /** Ordered items joined with their pastes. */
  listItems(collectionId: string): Promise<{ pasteId: string; position: number; addedAt: Date; paste: Paste }[]> {
    return prisma.collectionPaste.findMany({
      where: { collectionId },
      orderBy: { position: 'asc' },
      include: { paste: true },
    });
  },

  nextPosition(collectionId: string, db: Db = prisma): Promise<number> {
    return db.collectionPaste
      .aggregate({ where: { collectionId }, _max: { position: true } })
      .then((r) => (r._max.position ?? -1) + 1);
  },

  addItem(collectionId: string, pasteId: string, position: number, db: Db = prisma): Promise<void> {
    return db.collectionPaste
      .create({ data: { collectionId, pasteId, position } })
      .then(() => undefined);
  },

  removeItem(collectionId: string, pasteId: string, db: Db = prisma): Promise<number> {
    return db.collectionPaste.deleteMany({ where: { collectionId, pasteId } }).then((r) => r.count);
  },

  listPositions(collectionId: string, db: Db = prisma): Promise<{ pasteId: string; position: number }[]> {
    return db.collectionPaste.findMany({
      where: { collectionId },
      orderBy: { position: 'asc' },
      select: { pasteId: true, position: true },
    });
  },

  setPosition(collectionId: string, pasteId: string, position: number, db: Db = prisma): Promise<void> {
    return db.collectionPaste
      .update({ where: { collectionId_pasteId: { collectionId, pasteId } }, data: { position } })
      .then(() => undefined);
  },

  countItems(collectionId: string, db: Db = prisma): Promise<number> {
    return db.collectionPaste.count({ where: { collectionId } });
  },
};
