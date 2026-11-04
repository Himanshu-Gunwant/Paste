import { z } from 'zod';
import { LANGUAGE_PATTERN, USERNAME_MAX, USERNAME_MIN, USERNAME_PATTERN } from '../config/constants.js';

export interface FeedQuery {
  sort?: 'latest' | 'popular' | 'trending';
  language?: string;
  username?: string;
  cursor?: string;
  limit?: number;
}

export const feedQuerySchema = z.object({
  sort: z.enum(['latest', 'popular', 'trending']).default('latest'),
  language: z.string().regex(LANGUAGE_PATTERN).optional(),
  username: z
    .string()
    .min(USERNAME_MIN)
    .max(USERNAME_MAX)
    .regex(USERNAME_PATTERN)
    .optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export interface SearchQuery extends FeedQuery {
  q: string;
}

export const searchQuerySchema = feedQuerySchema.extend({
  q: z.string().trim().min(1).max(200),
});
