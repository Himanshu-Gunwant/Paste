import { z } from 'zod';
import { RESERVED_WORDS, SLUG_PATTERN, USERNAME_MAX, USERNAME_MIN } from '../config/constants.js';

export interface CreateCollectionBody {
  title: string;
  description?: string;
  slug?: string;
  visibility?: 'public' | 'unlisted' | 'private';
}

export const createCollectionSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().max(500).optional(),
  slug: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(
      z
        .string()
        .regex(SLUG_PATTERN, 'Slug must be 3-64 chars: lowercase letters, digits, - and _')
        .refine((slug) => !RESERVED_WORDS.has(slug), 'Slug is reserved'),
    )
    .optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).default('private'),
});

export interface UpdateCollectionBody {
  title?: string;
  description?: string | null;
  slug?: string;
  visibility?: 'public' | 'unlisted' | 'private';
}

export const updateCollectionSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  description: z.string().trim().max(500).nullish(),
  slug: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.string().regex(SLUG_PATTERN).refine((slug) => !RESERVED_WORDS.has(slug), 'Slug is reserved'))
    .optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
});

export interface CollectionIdParams {
  id: string;
}

export const collectionIdParamsSchema = z.object({
  id: z.uuid(),
});

export interface AddPasteBody {
  pasteId: string;
}

export const addPasteSchema = z.object({
  pasteId: z.string().min(3).max(64),
});

export interface RemovePasteParams {
  id: string;
  pasteId: string;
}

export const removePasteParamsSchema = z.object({
  id: z.uuid(),
  pasteId: z.string().min(3).max(64),
});

export interface ReorderBody {
  positions: { pasteId: string; position: number }[];
}

export const reorderSchema = z.object({
  positions: z
    .array(z.object({ pasteId: z.string().min(3).max(64), position: z.number().int().min(0).max(1000) }))
    .min(1)
    .max(200),
});

export const usernameCollectionsParamsSchema = z.object({
  username: z
    .string()
    .min(USERNAME_MIN)
    .max(USERNAME_MAX)
    .transform((value) => value.trim().toLowerCase()),
});

export const bookmarkParamsSchema = z.object({
  id: z.string().min(3).max(64),
});
