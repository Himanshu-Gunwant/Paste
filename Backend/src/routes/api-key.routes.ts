import { Router } from 'express';
import { requireAuth } from '../middleware/require-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import * as apiKeyController from '../controllers/api-key.controller.js';
import { apiKeyIdParamsSchema, createApiKeySchema } from '../validators/api-key.validators.js';

/** API key management (docs/ARCHITECTURE.md §7.2) — dashboard-only (session). */
export const apiKeysRouter = Router();

const keyLimiter = rateLimit({ bucket: 'api-keys', limit: 10, windowSeconds: 3600 });

apiKeysRouter.post('/', keyLimiter, requireAuth(), validateBody(createApiKeySchema), apiKeyController.create);
apiKeysRouter.get('/', requireAuth(), apiKeyController.list);
apiKeysRouter.delete('/:id', requireAuth(), validateParams(apiKeyIdParamsSchema), apiKeyController.revoke);
