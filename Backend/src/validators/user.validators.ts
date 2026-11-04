import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, USERNAME_MAX, USERNAME_MIN } from '../config/constants.js';

export interface UpdateMeBody {
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  websiteUrl?: string | null;
}

export const updateMeSchema = z.object({
  displayName: z.string().trim().max(80).nullish(),
  bio: z.string().trim().max(280).nullish(),
  avatarUrl: z.url().max(2048).nullish(),
  websiteUrl: z.url().max(2048).nullish(),
});

export interface DeleteMeBody {
  password?: string;
}

/** DELETE /users/me — body is optional entirely (OAuth-only accounts). */
export const deleteMeSchema = z
  .object({
    password: z.string().max(PASSWORD_MAX_LENGTH).optional(),
  })
  .optional();

export const usernameParamsSchema = z.object({
  username: z
    .string()
    .min(USERNAME_MIN)
    .max(USERNAME_MAX)
    .transform((value) => value.trim().toLowerCase()),
});

export const sessionIdParamsSchema = z.object({
  id: z.string().min(8).max(128),
});
