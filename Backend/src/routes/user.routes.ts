import { Router } from 'express';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as userController from '../controllers/user.controller.js';
import * as apiKeyController from '../controllers/api-key.controller.js';
import {
  deleteMeSchema,
  sessionIdParamsSchema,
  updateMeSchema,
  usernameParamsSchema,
} from '../validators/user.validators.js';
import { feedQuerySchema } from '../validators/discovery.validators.js';

/**
 * User routes (docs/ARCHITECTURE.md §7.2). /me routes require a session and
 * are registered BEFORE the public /:username route so 'me' never collides
 * with a username lookup.
 */
export const userRouter = Router();

userRouter.get('/me', requireAuth(), userController.getMe);
userRouter.patch('/me', requireAuth(), validateBody(updateMeSchema), userController.updateMe);
userRouter.delete('/me', requireAuth(), validateBody(deleteMeSchema), userController.deleteMe);
userRouter.get('/me/api-usage', requireAuth(), apiKeyController.myUsage);
userRouter.get('/me/sessions', requireAuth(), userController.listSessions);
userRouter.delete('/me/sessions', requireAuth(), userController.revokeAllSessions);
userRouter.delete('/me/sessions/:id', requireAuth(), validateParams(sessionIdParamsSchema), userController.revokeSession);

// Public pastes (leak-proof: database-level PUBLIC + live + active filters).
userRouter.get('/:username/pastes', validateParams(usernameParamsSchema), validateQuery(feedQuerySchema), userController.getUserPublicPastes);

// Public profile (uniform 404 for missing/deleted/suspended users).
userRouter.get('/:username', validateParams(usernameParamsSchema), userController.getPublicProfile);
