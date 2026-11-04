import { Router } from 'express';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import * as userController from '../controllers/user.controller.js';
import {
  deleteMeSchema,
  sessionIdParamsSchema,
  updateMeSchema,
  usernameParamsSchema,
} from '../validators/user.validators.js';

/**
 * User routes (docs/ARCHITECTURE.md §7.2). /me routes require a session and
 * are registered BEFORE the public /:username route so 'me' never collides
 * with a username lookup.
 */
export const userRouter = Router();

userRouter.get('/me', requireAuth(), userController.getMe);
userRouter.patch('/me', requireAuth(), validateBody(updateMeSchema), userController.updateMe);
userRouter.delete('/me', requireAuth(), validateBody(deleteMeSchema), userController.deleteMe);
userRouter.get('/me/sessions', requireAuth(), userController.listSessions);
userRouter.delete('/me/sessions', requireAuth(), userController.revokeAllSessions);
userRouter.delete('/me/sessions/:id', requireAuth(), validateParams(sessionIdParamsSchema), userController.revokeSession);

// Public profile (uniform 404 for missing/deleted/suspended users).
userRouter.get('/:username', validateParams(usernameParamsSchema), userController.getPublicProfile);
