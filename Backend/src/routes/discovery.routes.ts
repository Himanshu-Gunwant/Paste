import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import * as discoveryController from '../controllers/discovery.controller.js';
import { feedQuerySchema, searchQuerySchema } from '../validators/discovery.validators.js';

/** Discovery routes (docs/ARCHITECTURE.md §7.2) — public, database-level leak protection. */
export const discoveryRouter = Router();

const searchLimiter = rateLimit({ bucket: 'search', ...RATE_LIMITS.SEARCH });

discoveryRouter.get('/pastes', validateQuery(feedQuerySchema), discoveryController.feed);
discoveryRouter.get('/search', searchLimiter, validateQuery(searchQuerySchema), discoveryController.search);
discoveryRouter.get('/languages', discoveryController.languages);
