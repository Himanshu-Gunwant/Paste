import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import * as pasteController from '../controllers/paste.controller.js';
import {
  createPasteSchema,
  forkSchema,
  idOrSlugParamsSchema,
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
