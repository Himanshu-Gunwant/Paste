import type { RequestHandler } from 'express';
import * as analyticsService from '../services/analytics.service.js';
import { AppError } from '../lib/errors.js';
import * as pasteService from '../services/paste.service.js';

/** Analytics endpoints (docs/ARCHITECTURE.md §4 K) — owner/admin only for pastes. */
export const pasteStats: RequestHandler = async (req, res) => {
  const idOrSlug = typeof req.params['id'] === 'string' ? req.params['id'] : '';
  const paste = await pasteService.authorizePasteRead(idOrSlug, req.auth, {});
  if (req.auth.kind === 'anonymous') throw AppError.unauthorized();
  const isOwner = paste.paste.authorId === req.auth.user.id || req.auth.user.role === 'ADMIN';
  if (!isOwner) throw AppError.forbidden();
  const stats = await analyticsService.getPasteStats(paste.paste.id);
  res.status(200).json({ stats });
};

export const myAnalytics: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw AppError.unauthorized();
  const analytics = await analyticsService.getUserAnalytics(req.auth.user.id);
  res.status(200).json(analytics);
};
