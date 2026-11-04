import type { Request, RequestHandler, Response } from 'express';
import * as pasteService from '../services/paste.service.js';
import type { PasteWithAuthor } from '../services/paste.service.js';
import type { AuthContext } from '../types/auth.js';
import type { CreatePasteBody, ForkBody, ShareTokenBody, ShareTokenParams, UnlockBody, UpdatePasteBody } from '../validators/paste.validators.js';

const MANAGEMENT_TOKEN_HEADER = 'x-management-token';

const FILE_EXTENSIONS: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', ruby: 'rb',
  php: 'php', go: 'go', rust: 'rs', java: 'java', html: 'html', css: 'css',
  json: 'json', xml: 'xml', sql: 'sql', cpp: 'cpp', c: 'c', yaml: 'yaml',
  markdown: 'md', perl: 'pl',
};

function managementToken(req: Request): string | undefined {
  const header = req.headers[MANAGEMENT_TOKEN_HEADER];
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

function shareToken(req: Request): string | undefined {
  const value = req.query['share_token'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isOwnerOrAdmin(auth: AuthContext, paste: PasteWithAuthor): boolean {
  if (auth.kind === 'anonymous') return false;
  return auth.user.id === paste.authorId || auth.user.role === 'ADMIN';
}

function toPasteView(
  paste: PasteWithAuthor,
  opts: { includeContent: boolean; includeStats: boolean },
) {
  return {
    id: paste.id,
    title: paste.title,
    description: paste.description,
    language: paste.language,
    detectedLanguage: paste.detectedLanguage,
    visibility: paste.visibility.toLowerCase(),
    author: paste.author ? { username: paste.author.username } : null,
    forkOfId: paste.forkOfId,
    contentSize: paste.contentSize,
    burnAfterRead: paste.burnAfterRead,
    expiresAt: paste.expiresAt,
    createdAt: paste.createdAt,
    updatedAt: paste.updatedAt,
    ...(opts.includeContent ? { content: paste.content } : {}),
    ...(opts.includeStats
      ? {
          viewCount: Number(paste.viewCount),
          maxViews: paste.maxViews,
          burnedAt: paste.burnedAt,
          deletedAt: paste.deletedAt,
        }
      : {}),
  };
}

export const create: RequestHandler = async (req, res) => {
  const body = req.validated.body as CreatePasteBody;
  const result = await pasteService.createPaste(body, req.auth, { ip: req.ip ?? null });
  res.status(201).json({
    paste: toPasteView(result.paste, { includeContent: false, includeStats: false }),
    // Shown exactly once — anonymous owners need it to manage the paste.
    ...(result.managementToken ? { managementToken: result.managementToken } : {}),
  });
};

export const getView: RequestHandler = async (req, res) => {
  const result = await pasteService.getPasteForView(req.params['id'] as string, req.auth, {
    shareToken: shareToken(req),
    managementToken: managementToken(req),
    visitorIp: req.ip ?? null,
    visitorUserAgent: req.headers['user-agent'] ?? null,
  });
  const includeStats = isOwnerOrAdmin(req.auth, result.paste);
  res.status(200).json({ paste: toPasteView(result.paste, { includeContent: true, includeStats }) });
};

/** text/plain raw retrieval — one authorized delivery per burn paste. */
async function deliverRaw(req: Request, res: Response, asAttachment: boolean): Promise<void> {
  const result = await pasteService.getPasteForView(req.params['id'] as string, req.auth, {
    shareToken: shareToken(req),
    managementToken: managementToken(req),
    visitorIp: req.ip ?? null,
    visitorUserAgent: req.headers['user-agent'] ?? null,
  });
  const cacheControl =
    result.paste.visibility === 'PUBLIC'
      ? 'public, max-age=60'
      : 'private, no-store';
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (asAttachment) {
    const ext = FILE_EXTENSIONS[result.paste.language ?? ''] ?? 'txt';
    const base = (result.paste.title ?? result.paste.id).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${ext}"`);
  }
  res.status(200).type('text/plain; charset=utf-8').send(result.paste.content ?? '');
}

export const getRaw: RequestHandler = (req, res) => void deliverRaw(req, res, false);

export const getDownload: RequestHandler = (req, res) => void deliverRaw(req, res, true);

/** Password gate: full paste on success; nothing is stored client-side. */
export const unlock: RequestHandler = async (req, res) => {
  const body = req.validated.body as UnlockBody;
  const result = await pasteService.getPasteForView(req.params['id'] as string, req.auth, {
    password: body.password,
    shareToken: shareToken(req),
    visitorIp: req.ip ?? null,
    visitorUserAgent: req.headers['user-agent'] ?? null,
  });
  const includeStats = isOwnerOrAdmin(req.auth, result.paste);
  res.status(200).json({ paste: toPasteView(result.paste, { includeContent: true, includeStats }) });
};

export const update: RequestHandler = async (req, res) => {
  const body = req.validated.body as UpdatePasteBody;
  const updated = await pasteService.updatePaste(
    req.params['id'] as string,
    body,
    req.auth,
    managementToken(req),
  );
  const includeStats = isOwnerOrAdmin(req.auth, updated);
  res.status(200).json({ paste: toPasteView(updated, { includeContent: true, includeStats }) });
};

export const remove: RequestHandler = async (req, res) => {
  const deletedBy = req.auth.kind !== 'anonymous' && req.auth.user.role === 'ADMIN' ? 'MODERATOR' : 'USER';
  await pasteService.deletePaste(req.params['id'] as string, req.auth, managementToken(req), deletedBy);
  res.status(204).send();
};

export const fork: RequestHandler = async (req, res) => {
  const body = (req.validated.body ?? undefined) as ForkBody | undefined;
  const result = await pasteService.forkPaste(req.params['id'] as string, req.auth, {
    password: body?.password,
    shareToken: shareToken(req),
    ip: req.ip ?? null,
  });
  res.status(201).json({
    paste: toPasteView(result.paste, { includeContent: false, includeStats: false }),
    ...(result.managementToken ? { managementToken: result.managementToken } : {}),
  });
};

export const createShareToken: RequestHandler = async (req, res) => {
  const body = (req.validated.body ?? undefined) as ShareTokenBody | undefined;
  const result = await pasteService.createShareToken(req.params['id'] as string, req.auth, body ?? {});
  res.status(201).json(result);
};

export const revokeShareToken: RequestHandler = async (req, res) => {
  const params = req.validated.params as ShareTokenParams;
  await pasteService.revokeShareToken(params.id, params.tokenId, req.auth);
  res.status(204).send();
};
