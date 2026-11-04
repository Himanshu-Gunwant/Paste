import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { env } from '../config/env.js';
import { authContext } from '../middleware/auth-context.js';
import { originGuard } from '../middleware/origin-guard.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { authRouter } from './auth.routes.js';
import { pastesRouter } from './paste.routes.js';
import { userRouter } from './user.routes.js';

/**
 * Versioned API surface (docs/ARCHITECTURE.md §7, §14). Cross-cutting order:
 * global rate limit → CSRF origin guard → auth-context resolution → routers.
 * Controllers validate, services decide.
 */
export const apiRouter = Router();

apiRouter.use(rateLimit({ bucket: 'global', ...RATE_LIMITS.GLOBAL_PER_IP }));

const allowedOrigins = [env.APP_BASE_URL, ...(env.FRONTEND_ORIGIN ? [env.FRONTEND_ORIGIN] : [])];
apiRouter.use(originGuard(allowedOrigins));

apiRouter.use(authContext());

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/pastes', pastesRouter);

// Phase 3+: revisionsRouter (under /pastes/:id/revisions), collectionsRouter,
// bookmarksRouter, searchRouter, apiKeysRouter, analyticsRouter, adminRouter.
