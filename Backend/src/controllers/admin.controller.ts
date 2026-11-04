import type { Request, RequestHandler } from 'express';
import * as adminService from '../services/admin.service.js';
import * as reportService from '../services/report.service.js';
import type { AdminActor } from '../services/admin.service.js';
import type {
  CreateIpBanBody,
  ResolveReportBody,
  ReportBody,
  SuspendBody,
} from '../validators/admin.validators.js';

/**
 * Abuse + administration HTTP adapters (docs/ARCHITECTURE.md §4 J, §7.2).
 * Route access requires role=ADMIN (requireAuth); every mutation is audited
 * inside the services with the acting admin's identity.
 */
function adminActor(req: Request): AdminActor {
  if (req.auth.kind === 'anonymous') throw new Error('unreachable behind requireAuth');
  return { actor: req.auth.user, ip: req.ip ?? null };
}

// ---- Reports ----------------------------------------------------------------

export const createReport: RequestHandler = async (req, res) => {
  const body = req.validated.body as ReportBody;
  const result = await reportService.createReport(body, req.auth, req.ip ?? null);
  res.status(201).json(result);
};

// ---- Admin ------------------------------------------------------------------

export const stats: RequestHandler = async (_req, res) => {
  res.status(200).json(await adminService.adminStats());
};

export const listUsers: RequestHandler = async (req, res) => {
  const query = (req.validated.query ?? {}) as { q?: string };
  res.status(200).json({ data: await adminService.listUsers(query.q) });
};

export const listPastes: RequestHandler = async (req, res) => {
  const query = (req.validated.query ?? {}) as { q?: string; deleted?: boolean };
  res.status(200).json({ data: await adminService.listPastes(query.q, query.deleted ?? false) });
};

export const purgePaste: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  await adminService.hardPurgePaste(adminActor(req), params.id);
  res.status(204).send();
};

export const suspendUser: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const body = req.validated.body as SuspendBody;
  await adminService.suspendUser(adminActor(req), params.id, {
    reason: body.reason,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
  });
  res.status(204).send();
};

export const unsuspendUser: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  await adminService.unsuspendUser(adminActor(req), params.id);
  res.status(204).send();
};

export const listReports: RequestHandler = async (req, res) => {
  const query = (req.validated.query ?? {}) as { status?: 'OPEN' | 'REVIEWED' | 'RESOLVED' | 'DISMISSED' };
  res.status(200).json({ data: await adminService.listReports(query.status) });
};

export const resolveReport: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  const body = req.validated.body as ResolveReportBody;
  await adminService.resolveReport(adminActor(req), params.id, body);
  res.status(204).send();
};

export const listAuditLogs: RequestHandler = async (req, res) => {
  const query = (req.validated.query ?? {}) as { limit?: number; offset?: number };
  res.status(200).json(await adminService.listAuditLogs(query.limit ?? 50, query.offset ?? 0));
};

export const listIpBans: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: await adminService.listIpBans() });
};

export const createIpBan: RequestHandler = async (req, res) => {
  const body = req.validated.body as CreateIpBanBody;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expiresAt must be in the future' } });
    return;
  }
  await adminService.createIpBan(adminActor(req), {
    ip: body.ip,
    reason: body.reason,
    expiresAt,
  });
  res.status(201).json({ status: 'banned' });
};

export const deleteIpBan: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string };
  await adminService.deleteIpBan(adminActor(req), params.id);
  res.status(204).send();
};
