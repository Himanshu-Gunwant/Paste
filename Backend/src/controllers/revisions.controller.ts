import type { Request, RequestHandler } from 'express';
import * as revisionService from '../services/revision.service.js';

/**
 * Revision HTTP adapters (docs/ARCHITECTURE.md §4 E, §11). Locked pastes
 * expose revisions to password-holders via the X-Paste-Password header
 * (redacted in logs) — the password is never persisted client-side.
 */
function readOptions(req: Request) {
  return {
    shareToken: typeof req.query['share_token'] === 'string' ? req.query['share_token'] : undefined,
    password: typeof req.headers['x-paste-password'] === 'string' ? req.headers['x-paste-password'] : undefined,
  };
}

function managementToken(req: Request): string | undefined {
  const header = req.headers['x-management-token'];
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

export const list: RequestHandler = async (req, res) => {
  const result = await revisionService.listRevisions(req.params['id'] as string, req.auth, readOptions(req));
  res.status(200).json({
    data: result.data.map((revision) => ({
      revisionNo: revision.revisionNo,
      title: revision.title,
      description: revision.description,
      language: revision.language,
      contentSize: revision.contentSize,
      createdAt: revision.createdAt,
    })),
    latestRevisionNo: result.paste.latestRevisionNo,
  });
};

export const getOne: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string; no: number };
  const result = await revisionService.getRevision(params.id, params.no, req.auth, readOptions(req));
  res.status(200).json({
    revision: {
      revisionNo: result.revision.revisionNo,
      title: result.revision.title,
      description: result.revision.description,
      language: result.revision.language,
      content: result.revision.content,
      contentSize: result.revision.contentSize,
      createdAt: result.revision.createdAt,
    },
  });
};

export const diff: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string; no: number };
  const query = req.validated.query as { to: number };
  const result = await revisionService.diffRevisions(params.id, params.no, query.to, req.auth, readOptions(req));
  res.status(200).json(result.diff);
};

export const restore: RequestHandler = async (req, res) => {
  const params = req.validated.params as { id: string; no: number };
  const result = await revisionService.restoreRevision(params.id, params.no, req.auth, managementToken(req));
  res.status(200).json({
    restored: result.restored,
    latestRevisionNo: result.paste.latestRevisionNo,
  });
};
