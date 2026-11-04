import { z } from 'zod';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
} from '../config/constants.js';

/**
 * Auth request schemas — Zod is the single source of truth for request
 * shapes (reused for OpenAPI in Phase 5). Normalization (email/username
 * lowercasing) happens here; business rules live in services.
 */
export interface RegisterBody {
  email: string;
  username: string;
  password: string;
}

export const registerSchema = z.object({
  email: z.email().max(255).transform((value) => value.trim().toLowerCase()),
  username: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(
      z
        .string()
        .min(USERNAME_MIN)
        .max(USERNAME_MAX)
        .regex(USERNAME_PATTERN, 'Username may only contain lowercase letters, digits, - and _'),
    ),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export interface LoginBody {
  email: string;
  password: string;
}

export const loginSchema = z.object({
  email: z.email().max(255).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export interface PasswordResetRequestBody {
  email: string;
}

export const passwordResetRequestSchema = z.object({
  email: z.email().max(255).transform((value) => value.trim().toLowerCase()),
});

export interface PasswordResetConfirmBody {
  token: string;
  newPassword: string;
}

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export interface VerifyEmailConfirmBody {
  token: string;
}

export const verifyEmailConfirmSchema = z.object({
  token: z.string().min(10).max(200),
});

export const verifyEmailQuerySchema = z.object({
  token: z.string().min(10).max(200),
});

export const oauthProviderParamsSchema = z.object({
  provider: z.string().min(2).max(16),
});
