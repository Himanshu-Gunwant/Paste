import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as pasteController from '../controllers/paste.controller.js';
import * as revisionsController from '../controllers/revisions.controller.js';
import * as collectionController from '../controllers/collection.controller.js';
import * as analyticsController from '../controllers/analytics.controller.js';
import {
  createPasteSchema,
  diffQuerySchema,
  forkSchema,
  idOrSlugParamsSchema,
  revisionParamsSchema,
  unlockSchema,
  updatePasteSchema,
} from '../validators/paste.validators.js';

/**
 * Paste routes (docs/ARCHITECTURE.md §7.2). Authorization is NEVER here:
 * limits are identity-scoped (anon vs user), and the service layer decides
 * visibility/password/management-token outcomes.
 */
export const pastesRouter = Router();

const anonCreateLimiter = rateLimit({
  bucket: 'paste-create-anon',
  ...RATE_LIMITS.PASTE_CREATE_ANON,
  skip: (req) => req.auth.kind !== 'anonymous',
});
const userCreateLimiter = rateLimit({
  bucket: 'paste-create-user',
  ...RATE_LIMITS.PASTE_CREATE_USER,
  skip: (req) => req.auth.kind === 'anonymous',
});
const readLimiter = rateLimit({ bucket: 'paste-read', ...RATE_LIMITS.PASTE_READ });
const writeLimiter = rateLimit({ bucket: 'paste-write', ...RATE_LIMITS.PASTE_WRITE });
const rawLimiter = rateLimit({ bucket: 'raw-download', ...RATE_LIMITS.RAW_DOWNLOAD });
const unlockLimiter = rateLimit({
  bucket: 'unlock',
  ...RATE_LIMITS.UNLOCK,
  identity: (req) => `${req.ip ?? 'unknown'}:${typeof req.params['id'] === 'string' ? req.params['id'] : ''}`,
});
const forkLimiter = rateLimit({ bucket: 'fork', ...RATE_LIMITS.FORK });

pastesRouter.post(
  '/',
  anonCreateLimiter,
  userCreateLimiter,
  validateBody(createPasteSchema),
  pasteController.create,
);

pastesRouter.get('/:id', readLimiter, validateParams(idOrSlugParamsSchema), pasteController.getView);
pastesRouter.get('/:id/raw', rawLimiter, validateParams(idOrSlugParamsSchema), pasteController.getRaw);
pastesRouter.get('/:id/download', rawLimiter, validateParams(idOrSlugParamsSchema), pasteController.getDownload);

pastesRouter.post(
  '/:id/unlock',
  unlockLimiter,
  validateParams(idOrSlugParamsSchema),
  validateBody(unlockSchema),
  pasteController.unlock,
);

pastesRouter.post(
  '/:id/fork',
  forkLimiter,
  validateParams(idOrSlugParamsSchema),
  validateBody(forkSchema),
  pasteController.fork,
);

pastesRouter.patch(
  '/:id',
  writeLimiter,
  validateParams(idOrSlugParamsSchema),
  validateBody(updatePasteSchema),
  pasteController.update,
);

pastesRouter.delete('/:id', writeLimiter, validateParams(idOrSlugParamsSchema), pasteController.remove);

pastesRouter.get('/:id/stats', readLimiter, validateParams(idOrSlugParamsSchema), analyticsController.pasteStats);

// Bookmarks (Phase 6) — session required, viewability-gated, idempotent.
const bookmarkLimiter = rateLimit({ bucket: 'bookmark', limit: 120, windowSeconds: 60 });
pastesRouter.put('/:id/bookmark', bookmarkLimiter, requireAuth(), validateParams(idOrSlugParamsSchema), collectionController.addBookmark);
pastesRouter.delete('/:id/bookmark', bookmarkLimiter, requireAuth(), validateParams(idOrSlugParamsSchema), collectionController.removeBookmark);

// Revisions (Phase 3) — readable by anyone who can read the paste; restore
// requires the manage decision (owner/management token/admin).
pastesRouter.get('/:id/revisions', readLimiter, validateParams(idOrSlugParamsSchema), revisionsController.list);
pastesRouter.get('/:id/revisions/:no', readLimiter, validateParams(revisionParamsSchema), revisionsController.getOne);
pastesRouter.get(
  '/:id/revisions/:no/diff',
  readLimiter,
  validateParams(revisionParamsSchema),
  validateQuery(diffQuerySchema),
  revisionsController.diff,
);
pastesRouter.post(
  '/:id/revisions/:no/restore',
  writeLimiter,
  validateParams(revisionParamsSchema),
  revisionsController.restore,
);
