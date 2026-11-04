import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { env } from '../config/env.js';
import { authContext } from '../middleware/auth-context.js';
import { originGuard } from '../middleware/origin-guard.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { apiKeyQuota, apiUsageRecorder } from '../middleware/api-usage.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { discoveryRouter } from './discovery.routes.js';
import { apiKeysRouter } from './api-key.routes.js';
import { authRouter } from './auth.routes.js';
import { collectionsRouter } from './collection.routes.js';
import { reportsRouter } from './reports.routes.js';
import { adminRouter } from './admin.routes.js';
import { ipBanGuard } from '../middleware/ip-guard.js';
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
apiRouter.use(apiKeyQuota()); // API-key daily quotas (§4 H)
apiRouter.use(apiUsageRecorder()); // buffered usage capture
apiRouter.use(idempotencyGuard()); // paste-creation idempotency keys
apiRouter.use(ipBanGuard()); // anonymous write paths (§4 J)

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use(discoveryRouter); // GET /pastes, /search, /languages
apiRouter.use('/pastes', pastesRouter);
apiRouter.use('/api-keys', apiKeysRouter);
apiRouter.use('/collections', collectionsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/admin', adminRouter);

// Phase 3+: revisionsRouter (under /pastes/:id/revisions), collectionsRouter,
// bookmarksRouter, searchRouter, apiKeysRouter, analyticsRouter, adminRouter.
