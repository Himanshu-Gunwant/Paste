import { Router } from 'express';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as adminController from '../controllers/admin.controller.js';
import {
  adminListQuerySchema,
  createIpBanSchema,
  ipBanIdParamsSchema,
  pasteIdParamsSchema,
  reportIdParamsSchema,
  resolveReportSchema,
  suspendSchema,
  userIdParamsSchema,
} from '../validators/admin.validators.js';

/**
 * Administration (docs/ARCHITECTURE.md §7.2) — double-guarded: requireAuth
 * enforces role=ADMIN and every service action audits with the actor.
 */
export const adminRouter = Router();

adminRouter.use(requireAuth({ role: 'ADMIN' }));

adminRouter.get('/stats', adminController.stats);
adminRouter.get('/users', validateQuery(adminListQuerySchema), adminController.listUsers);
adminRouter.get('/pastes', validateQuery(adminListQuerySchema), adminController.listPastes);
adminRouter.post('/pastes/:id/purge', validateParams(pasteIdParamsSchema), adminController.purgePaste);
adminRouter.post('/users/:id/suspend', validateParams(userIdParamsSchema), validateBody(suspendSchema), adminController.suspendUser);
adminRouter.post('/users/:id/unsuspend', validateParams(userIdParamsSchema), adminController.unsuspendUser);
adminRouter.get('/reports', validateQuery(adminListQuerySchema), adminController.listReports);
adminRouter.post('/reports/:id/resolve', validateParams(reportIdParamsSchema), validateBody(resolveReportSchema), adminController.resolveReport);
adminRouter.get('/audit-logs', validateQuery(adminListQuerySchema), adminController.listAuditLogs);
adminRouter.get('/ip-bans', adminController.listIpBans);
adminRouter.post('/ip-bans', validateBody(createIpBanSchema), adminController.createIpBan);
adminRouter.delete('/ip-bans/:id', validateParams(ipBanIdParamsSchema), adminController.deleteIpBan);
