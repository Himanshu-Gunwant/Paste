import { AppError } from '../lib/errors.js';
import { generatePasteId } from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import {
  collectionRepository,
  type CollectionWithOwner,
} from '../repositories/collection.repository.js';
import type { Collection } from '../generated/prisma/client.js';
import { pasteRepository } from '../repositories/paste.repository.js';
import { authorizePasteView, type PasteViewContext } from './access-policy.js';
import type { AuthContext } from '../types/auth.js';
import type {
  CreateCollectionBody,
  ReorderBody,
  UpdateCollectionBody,
} from '../validators/collection.validators.js';

/**
 * Collections (docs/ARCHITECTURE.md §4 F). Owner-scoped slugs, own
 * visibility, and the critical leak rule: items a viewer cannot see render
 * as `{ restricted: true }` with NO id/title — never an id leak for
 * private pastes inside public collections.
 */

function requireOwner(collection: Collection, auth: AuthContext): void {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  if (collection.ownerId !== auth.user.id && auth.user.role !== 'ADMIN') {
    throw AppError.notFound(); // uniform anti-enumeration for private collections
  }
}

function canView(collection: Collection, auth: AuthContext): boolean {
  if (collection.visibility === 'PRIVATE') {
    return auth.kind !== 'anonymous' && (collection.ownerId === auth.user.id || auth.user.role === 'ADMIN');
  }
  return true;
}

export async function createCollection(
  body: CreateCollectionBody,
  auth: AuthContext,
): Promise<CollectionWithOwner> {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();

  let slug = body.slug;
  if (slug) {
    const existing = await collectionRepository.findByOwnerAndSlug(auth.user.id, slug);
    if (existing) throw AppError.conflict('Slug is already taken for one of your collections');
  } else {
    // Derive a unique slug from the title.
    const base =
      body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) ||
      'collection';
    slug = base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await collectionRepository.findByOwnerAndSlug(auth.user.id, slug);
      if (!existing) break;
      slug = `${base}-${generatePasteId().toLowerCase().slice(0, 6)}`;
    }
    if (await collectionRepository.findByOwnerAndSlug(auth.user.id, slug)) {
      throw AppError.conflict('Could not allocate a collection slug, please provide one');
    }
  }

  const created = await collectionRepository.create({
    ownerId: auth.user.id,
    slug,
    title: body.title,
    description: body.description ?? null,
    visibility: body.visibility?.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE',
  });
  const fresh = await collectionRepository.findByIdWithOwner(created.id);
  return fresh ?? (created as CollectionWithOwner);
}

export async function listOwnCollections(auth: AuthContext) {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  return collectionRepository.listForOwner(auth.user.id);
}

export interface CollectionItemView {
  position: number;
  addedAt: Date;
  restricted?: boolean;
  paste?: {
    id: string;
    title: string | null;
    language: string | null;
    viewCount: string;
    createdAt: Date;
  };
}

export async function getCollection(
  id: string,
  auth: AuthContext,
): Promise<{ collection: CollectionWithOwner; items: CollectionItemView[] }> {
  const collection = await collectionRepository.findByIdWithOwner(id);
  if (!collection) throw AppError.notFound();
  if (!canView(collection, auth)) throw AppError.notFound();

  const items = await collectionRepository.listItems(collection.id);
  const ctx: PasteViewContext = { auth };
  const views: CollectionItemView[] = [];

  for (const item of items) {
    const decision = authorizePasteView(item.paste, ctx);
    // Burned/expired/tombstoned items also count as restricted.
    const live = item.paste.deletedAt === null;
    if (decision.outcome === 'ALLOW' && live && item.paste.content !== null) {
      views.push({
        position: item.position,
        addedAt: item.addedAt,
        paste: {
          id: item.paste.id,
          title: item.paste.title,
          language: item.paste.language,
          viewCount: item.paste.viewCount.toString(),
          createdAt: item.paste.createdAt,
        },
      });
    } else {
      // Metadata-only rendering WITHOUT the paste id (§4 F leak rule).
      views.push({ position: item.position, addedAt: item.addedAt, restricted: true });
    }
  }
  return { collection, items: views };
}

export async function updateCollection(
  id: string,
  body: UpdateCollectionBody,
  auth: AuthContext,
): Promise<CollectionWithOwner> {
  const collection = await collectionRepository.findById(id);
  if (!collection) throw AppError.notFound();
  requireOwner(collection, auth);

  if (body.slug && body.slug !== collection.slug) {
    const existing = await collectionRepository.findByOwnerAndSlug(collection.ownerId, body.slug);
    if (existing && existing.id !== collection.id) {
      throw AppError.conflict('Slug is already taken for one of your collections');
    }
  }

  const updated = await collectionRepository.update(collection.id, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
    ...(body.visibility !== undefined
      ? { visibility: body.visibility.toUpperCase() as 'PUBLIC' | 'UNLISTED' | 'PRIVATE' }
      : {}),
  });
  const fresh = await collectionRepository.findByIdWithOwner(updated.id);
  return fresh ?? (updated as CollectionWithOwner);
}

export async function deleteCollection(id: string, auth: AuthContext): Promise<void> {
  const collection = await collectionRepository.findById(id);
  if (!collection) throw AppError.notFound();
  requireOwner(collection, auth);
  await collectionRepository.delete(id); // items cascade
}

export async function addItem(
  id: string,
  pasteId: string,
  auth: AuthContext,
): Promise<{ position: number }> {
  const collection = await collectionRepository.findById(id);
  if (!collection) throw AppError.notFound();
  requireOwner(collection, auth);

  // The owner must be able to view the paste they are collecting.
  const paste = await pasteRepository.findByIdOrSlug(pasteId);
  if (!paste) throw AppError.notFound('Paste not found');
  const ctx: PasteViewContext = { auth };
  const decision = authorizePasteView(paste, ctx);
  if (decision.outcome === 'NOT_FOUND') throw AppError.notFound('Paste not found');
  if (decision.outcome === 'PASSWORD_REQUIRED') {
    throw AppError.validation('Locked pastes must be unlocked before collecting');
  }

  const duplicate = await prisma.collectionPaste.findUnique({
    where: { collectionId_pasteId: { collectionId: collection.id, pasteId: paste.id } },
    select: { pasteId: true },
  });
  if (duplicate) throw AppError.conflict('Paste is already in this collection');

  const position = await collectionRepository.nextPosition(collection.id);
  await collectionRepository.addItem(collection.id, paste.id, position);
  return { position };
}

export async function removeItem(id: string, pasteId: string, auth: AuthContext): Promise<void> {
  const collection = await collectionRepository.findById(id);
  if (!collection) throw AppError.notFound();
  requireOwner(collection, auth);

  const removed = await collectionRepository.removeItem(collection.id, pasteId);
  if (removed === 0) throw AppError.notFound('Paste is not in this collection');

  // Compact positions in a transaction (§4 F).
  const remaining = await collectionRepository.listPositions(collection.id);
  await prisma.$transaction(async (tx) => {
    let position = 0;
    for (const item of remaining) {
      await collectionRepository.setPosition(collection.id, item.pasteId, position, tx);
      position += 1;
    }
  });
}

export async function reorderItems(
  id: string,
  body: ReorderBody,
  auth: AuthContext,
): Promise<void> {
  const collection = await collectionRepository.findById(id);
  if (!collection) throw AppError.notFound();
  requireOwner(collection, auth);

  await prisma.$transaction(async (tx) => {
    for (const entry of body.positions) {
      await collectionRepository.setPosition(collection.id, entry.pasteId, entry.position, tx);
    }
  });
}

export async function listPublicCollections(username: string): Promise<CollectionWithOwner[]> {
  return collectionRepository.listPublicByUsername(username);
}
