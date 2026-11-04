import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { requireAuth } from '../middleware/require-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import * as collectionController from '../controllers/collection.controller.js';
import {
  addPasteSchema,
  collectionIdParamsSchema,
  createCollectionSchema,
  reorderSchema,
  removePasteParamsSchema,
  updateCollectionSchema,
} from '../validators/collection.validators.js';

/** Collection routes (docs/ARCHITECTURE.md §7.2) — authorization in the service. */
export const collectionsRouter = Router();

const writeLimiter = rateLimit({ bucket: 'collection-write', ...RATE_LIMITS.PASTE_WRITE });
const readLimiter = rateLimit({ bucket: 'collection-read', ...RATE_LIMITS.PASTE_READ });

collectionsRouter.post(
  '/',
  writeLimiter,
  requireAuth(),
  validateBody(createCollectionSchema),
  collectionController.create,
);
collectionsRouter.get('/', readLimiter, requireAuth(), collectionController.listOwn);

collectionsRouter.get(
  '/:id',
  readLimiter,
  validateParams(collectionIdParamsSchema),
  collectionController.getOne,
);
collectionsRouter.patch(
  '/:id',
  writeLimiter,
  requireAuth(),
  validateParams(collectionIdParamsSchema),
  validateBody(updateCollectionSchema),
  collectionController.update,
);
collectionsRouter.delete(
  '/:id',
  writeLimiter,
  requireAuth(),
  validateParams(collectionIdParamsSchema),
  collectionController.remove,
);

collectionsRouter.post(
  '/:id/pastes',
  writeLimiter,
  requireAuth(),
  validateParams(collectionIdParamsSchema),
  validateBody(addPasteSchema),
  collectionController.addItem,
);
collectionsRouter.patch(
  '/:id/pastes',
  writeLimiter,
  requireAuth(),
  validateParams(collectionIdParamsSchema),
  validateBody(reorderSchema),
  collectionController.reorder,
);
collectionsRouter.delete(
  '/:id/pastes/:pasteId',
  writeLimiter,
  requireAuth(),
  validateParams(removePasteParamsSchema),
  collectionController.removeItem,
);
