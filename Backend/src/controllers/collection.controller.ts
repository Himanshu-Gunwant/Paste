import type { Request, RequestHandler } from 'express';
import * as collectionService from '../services/collection.service.js';
import * as bookmarkService from '../services/bookmark.service.js';
import type { AuthContext } from '../types/auth.js';
import type {
  AddPasteBody,
  CreateCollectionBody,
  ReorderBody,
  UpdateCollectionBody,
} from '../validators/collection.validators.js';

function authOf(req: Request): AuthContext {
  return req.auth;
}

function toCollectionView(collection: {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
  owner: { username: string };
  _count?: { pastes: number };
}) {
  return {
    id: collection.id,
    slug: collection.slug,
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility.toLowerCase(),
    ownerUsername: collection.owner.username,
    itemCount: collection._count?.pastes,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

export const create: RequestHandler = async (req, res) => {
  const body = req.validated.body as CreateCollectionBody;
  const collection = await collectionService.createCollection(body, authOf(req));
  res.status(201).json({ collection: toCollectionView(collection) });
};

export const listOwn: RequestHandler = async (req, res) => {
  const collections = await collectionService.listOwnCollections(authOf(req));
  res.status(200).json({ data: collections.map(toCollectionView) });
};

export const getOne: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const { collection, items } = await collectionService.getCollection(params.id, authOf(req));
  res.status(200).json({
    collection: toCollectionView(collection),
    items: items.map((item) => ({
      position: item.position,
      addedAt: item.addedAt,
      ...(item.restricted ? { restricted: true } : { paste: item.paste }),
    })),
  });
};

export const update: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const body = req.validated.body as UpdateCollectionBody;
  const collection = await collectionService.updateCollection(params.id, body, authOf(req));
  res.status(200).json({ collection: toCollectionView(collection) });
};

export const remove: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  await collectionService.deleteCollection(params.id, authOf(req));
  res.status(204).send();
};

export const addItem: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const body = req.validated.body as AddPasteBody;
  const result = await collectionService.addItem(params.id, body.pasteId, authOf(req));
  res.status(201).json(result);
};

export const removeItem: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string; pasteId: string };
  await collectionService.removeItem(params.id, params.pasteId, authOf(req));
  res.status(204).send();
};

export const reorder: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const body = req.validated.body as ReorderBody;
  await collectionService.reorderItems(params.id, body, authOf(req));
  res.status(200).json({ status: 'ok' });
};

export const listPublicForUser: RequestHandler = async (req, res) => {
  const params = req.validated.params as { username: string };
  const collections = await collectionService.listPublicCollections(params.username);
  res.status(200).json({ data: collections.map(toCollectionView) });
};

// ---- Bookmarks -------------------------------------------------------------

export const addBookmark: RequestHandler = async (req, res) => {
  await bookmarkService.addBookmark(req.params['id'] as string, authOf(req));
  res.status(204).send();
};

export const removeBookmark: RequestHandler = async (req, res) => {
  await bookmarkService.removeBookmark(req.params['id'] as string, authOf(req));
  res.status(204).send();
};

export const listBookmarks: RequestHandler = async (req, res) => {
  const data = await bookmarkService.listBookmarks(authOf(req));
  res.status(200).json({ data });
};
