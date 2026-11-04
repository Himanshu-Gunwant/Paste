import { z } from 'zod';

export interface CreateApiKeyBody {
  name: string;
  expiresAt?: string;
}

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresAt: z.iso.datetime().optional(),
});

export interface ApiKeyIdParams {
  id: string;
}

export const apiKeyIdParamsSchema = z.object({
  id: z.uuid(),
});
