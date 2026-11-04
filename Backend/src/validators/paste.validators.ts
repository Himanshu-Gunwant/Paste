import { z } from 'zod';
import {
  EXPIRES_IN_PRESETS_SECONDS,
  LANGUAGE_PATTERN,
  MAX_PASTE_CONTENT_BYTES,
  PASTE_PASSWORD_MAX,
  PASTE_PASSWORD_MIN,
  RESERVED_WORDS,
  SLUG_PATTERN,
  type ExpiresInPreset,
} from '../config/constants.js';

/**
 * Paste request schemas (docs/ARCHITECTURE.md §7.2). The 1 MB content cap is
 * a BYTE limit — Zod's string max() counts code units, so this schema uses a
 * coarse guard and the service enforces the exact byte limit (413).
 */
const coarseContentSchema = z.string().min(1).max(MAX_PASTE_CONTENT_BYTES * 4);

const languageSchema = z
  .string()
  .regex(LANGUAGE_PATTERN, 'Language must be a lowercase identifier (a-z, 0-9, +, #, -)');

const customSlugSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(SLUG_PATTERN, 'Slug must be 3-64 chars: lowercase letters, digits, - and _')
      .refine((slug) => !RESERVED_WORDS.has(slug), 'Slug is reserved'),
  );

export interface CreatePasteBody {
  content: string;
  title?: string;
  description?: string;
  language?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  password?: string;
  expiresIn?: ExpiresInPreset;
  expiresAt?: string;
  maxViews?: number;
  burnAfterRead?: boolean;
  customSlug?: string;
}

export const createPasteSchema = z
  .object({
    content: coarseContentSchema,
    title: z.string().trim().max(140).optional(),
    description: z.string().trim().max(500).optional(),
    language: languageSchema.optional(),
    visibility: z.enum(['public', 'unlisted', 'private']).default('public'),
    password: z.string().min(PASTE_PASSWORD_MIN).max(PASTE_PASSWORD_MAX).optional(),
    expiresIn: z.enum(Object.keys(EXPIRES_IN_PRESETS_SECONDS) as [ExpiresInPreset]).optional(),
    expiresAt: z.iso.datetime().optional(),
    maxViews: z.number().int().min(1).max(1_000_000).optional(),
    burnAfterRead: z.boolean().default(false),
    customSlug: customSlugSchema.optional(),
  })
  .refine((body) => !(body.expiresIn && body.expiresAt), {
    message: 'Use either expiresIn or expiresAt, not both',
    path: ['expiresIn'],
  });

export interface UpdatePasteBody {
  content?: string;
  title?: string;
  description?: string;
  language?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  /** null removes the password; undefined leaves it unchanged. */
  password?: string | null;
  expiresIn?: ExpiresInPreset;
  /** null clears expiration; undefined leaves it unchanged. */
  expiresAt?: string | null;
  maxViews?: number | null;
  burnAfterRead?: boolean;
}

export const updatePasteSchema = z
  .object({
    content: coarseContentSchema.optional(),
    title: z.string().trim().max(140).optional(),
    description: z.string().trim().max(500).optional(),
    language: languageSchema.optional(),
    visibility: z.enum(['public', 'unlisted', 'private']).optional(),
    password: z.string().min(PASTE_PASSWORD_MIN).max(PASTE_PASSWORD_MAX).nullish(),
    expiresIn: z.enum(Object.keys(EXPIRES_IN_PRESETS_SECONDS) as [ExpiresInPreset]).optional(),
    expiresAt: z.iso.datetime().nullish(),
    maxViews: z.number().int().min(1).max(1_000_000).nullish(),
    burnAfterRead: z.boolean().optional(),
  })
  .refine((body) => !(body.expiresIn && body.expiresAt), {
    message: 'Use either expiresIn or expiresAt, not both',
    path: ['expiresIn'],
  });

export interface UnlockBody {
  password: string;
}

export const unlockSchema = z.object({
  password: z.string().min(1).max(PASTE_PASSWORD_MAX),
});

export interface IdOrSlugParams {
  id: string;
}

export const idOrSlugParamsSchema = z.object({
  id: z.string().min(3).max(64),
});
