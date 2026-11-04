import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import * as adminController from '../controllers/admin.controller.js';
import { reportSchema } from '../validators/admin.validators.js';

/** Abuse reports (docs/ARCHITECTURE.md §7.2) — anonymous allowed, rate-limited. */
export const reportsRouter = Router();

const reportLimiter = rateLimit({ bucket: 'reports', ...RATE_LIMITS.REPORTS });

reportsRouter.post('/', reportLimiter, validateBody(reportSchema), adminController.createReport);
