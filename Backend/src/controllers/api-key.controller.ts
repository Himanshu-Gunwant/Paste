import type { Request, RequestHandler } from 'express';
import { API_DAILY_QUOTA } from '../config/constants.js';
import { AppError } from '../lib/errors.js';
import * as apiKeyService from '../services/api-key.service.js';
import { apiUsageRepository } from '../repositories/api-usage.repository.js';
import type { CreateApiKeyBody } from '../validators/api-key.validators.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function requireSessionUser(req: Request) {
  if (req.auth.kind === 'anonymous') throw AppError.unauthorized();
  if (req.auth.kind === 'apiKey') {
    // Creating keys with a key amplifies leak persistence (§4 H).
    throw AppError.forbidden('API keys are managed from the dashboard (session required)');
  }
  return req.auth.user;
}

function toKeyView(apiKey: {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    lastUsedAt: apiKey.lastUsedAt,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    createdAt: apiKey.createdAt,
  };
}

/** Raw key shown exactly once (docs/ARCHITECTURE.md §4 H). */
export const create: RequestHandler = async (req, res) => {
  const user = requireSessionUser(req);
  const body = req.validated.body as CreateApiKeyBody;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw AppError.validation('expiresAt must be a future timestamp');
  }
  const { apiKey, rawKey } = await apiKeyService.createApiKey(user, {
    name: body.name,
    expiresAt,
  });
  res.status(201).json({
    apiKey: {
      ...toKeyView(apiKey),
      apiKey: rawKey, // one-time disclosure
    },
  });
};

export const list: RequestHandler = async (req, res) => {
  const user = requireSessionUser(req);
  const keys = await apiKeyService.listApiKeys(user.id);
  res.status(200).json({ data: keys.map(toKeyView) }); // hashes and raw keys never leave the server
};

export const revoke: RequestHandler = async (req, res) => {
  const user = requireSessionUser(req);
  const params = req.validated.params as { id: string };
  await apiKeyService.revokeApiKey(user.id, params.id);
  res.status(204).send();
};

export const myUsage: RequestHandler = async (req, res) => {
  if (req.auth.kind === 'anonymous') throw AppError.unauthorized();
  const since = new Date(Date.now() - THIRTY_DAYS_MS);
  const summary = await apiUsageRepository.summarizeForUser(req.auth.user.id, since);
  res.status(200).json({
    data: summary,
    quota: { dailyLimit: API_DAILY_QUOTA, window: 'UTC day' },
    windowDays: 30,
  });
};
