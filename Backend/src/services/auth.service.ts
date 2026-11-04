import {
  EMAIL_VERIFICATION_TTL_HOURS,
  PASSWORD_RESET_TTL_HOURS,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
  RESERVED_WORDS,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../lib/crypto.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { authTokenRepository } from '../repositories/auth-token.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { createSession, revokeAllSessions, revokeSessionByToken } from './session.service.js';
import { enqueueEmail } from './email.service.js';
import type { User } from '../generated/prisma/client.js';

const GENERIC_CREDENTIALS_MESSAGE = 'Invalid email or password';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function assertUsernameFormat(username: string): void {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    throw AppError.validation(`Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`);
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw AppError.validation('Username may only contain lowercase letters, digits, - and _');
  }
  if (RESERVED_WORDS.has(username)) {
    throw AppError.conflict('Username is reserved');
  }
}

function verificationLink(token: string): string {
  return `${env.APP_BASE_URL}/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function passwordResetLink(token: string): string {
  const frontend = env.FRONTEND_ORIGIN ?? env.APP_BASE_URL;
  return `${frontend}/reset-password?token=${encodeURIComponent(token)}`;
}

async function issueAuthToken(
  userId: string,
  type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ttlHours: number,
): Promise<string> {
  const token = generateToken();
  await authTokenRepository.create({
    id: hashToken(token),
    userId,
    type,
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
  });
  return token;
}

/**
 * Consumes a single-use token conditionally — two concurrent consumers
 * cannot both win (docs/ARCHITECTURE.md §5.2 single-use semantics).
 */
async function consumeToken(
  token: string,
  type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
): Promise<{ user: User } | null> {
  const stored = await authTokenRepository.findUsableWithUser(hashToken(token), type);
  if (!stored) return null;
  const consumed = await authTokenRepository.consume(stored.id);
  if (consumed === 0) return null;
  return { user: stored.user };
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

export async function register(
  input: RegisterInput,
): Promise<{ user: User; sessionToken: string }> {
  const email = normalizeEmail(input.email);
  const username = normalizeUsername(input.username);
  assertUsernameFormat(username);

  const policyError = passwordPolicyError(input.password);
  if (policyError) throw AppError.validation(policyError);

  // Precise pre-checks for 409 messages; the unique constraints remain the
  // race-safe authority (a lost race surfaces as the generic conflict below).
  if (await userRepository.findByEmail(email)) {
    throw AppError.conflict('Email is already registered');
  }
  if (await userRepository.findByUsername(username)) {
    throw AppError.conflict('Username is already taken');
  }

  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await userRepository.create({ email, username, passwordHash });
  } catch {
    // Unique-constraint race: uniform, non-enumerating response.
    throw AppError.conflict('Email or username is already in use');
  }

  const { token } = await createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent });
  await sendEmailVerificationForUser(user);

  return { user, sessionToken: token };
}

export interface LoginInput {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

export async function login(input: LoginInput): Promise<{ user: User; sessionToken: string }> {
  const email = normalizeEmail(input.email);
  const user = await userRepository.findByEmail(email);

  // Timing-equalized: unknown emails and OAuth-only accounts consume the
  // same argon2 work as a failed password check (docs/ARCHITECTURE.md §13).
  const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
  if (!user || !ok) {
    throw AppError.unauthorized(GENERIC_CREDENTIALS_MESSAGE);
  }
  if (user.status === 'SUSPENDED') {
    throw AppError.forbidden('This account is suspended');
  }
  if (user.status === 'DELETED' || user.deletedAt) {
    throw AppError.unauthorized(GENERIC_CREDENTIALS_MESSAGE);
  }

  const { token } = await createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent });
  return { user, sessionToken: token };
}

/** Idempotent logout — unknown/already-revoked tokens are a no-op. */
export async function logout(sessionToken: string): Promise<void> {
  await revokeSessionByToken(sessionToken);
}

export async function sendEmailVerificationForUser(user: User): Promise<void> {
  if (user.emailVerified) return;
  const token = await issueAuthToken(user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_HOURS);
  await enqueueEmail({
    type: 'email_verification',
    to: user.email,
    username: user.username,
    link: verificationLink(token),
  });
}

export async function confirmEmailVerification(token: string): Promise<User> {
  const consumed = await consumeToken(token, 'EMAIL_VERIFICATION');
  if (!consumed) throw AppError.validation('Invalid or expired verification link');
  return userRepository.setVerified(consumed.user.id);
}

export async function requestPasswordReset(email: string): Promise<void> {
  // Response is always 202 at the controller (anti-enumeration); this only
  // decides whether an email is actually dispatched.
  const user = await userRepository.findByEmail(normalizeEmail(email));
  if (!user || user.deletedAt || user.status === 'DELETED') return;

  const token = await issueAuthToken(user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_HOURS);
  await enqueueEmail({
    type: 'password_reset',
    to: user.email,
    username: user.username,
    link: passwordResetLink(token),
  });
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const policyError = passwordPolicyError(newPassword);
  if (policyError) throw AppError.validation(policyError);

  const consumed = await consumeToken(token, 'PASSWORD_RESET');
  if (!consumed) throw AppError.validation('Invalid or expired reset link');

  await userRepository.setPasswordHash(consumed.user.id, await hashPassword(newPassword));
  // Password change invalidates every existing session (§13 session hijacking).
  await revokeAllSessions(consumed.user.id);
}

export { revokeSessionForUser, revokeAllSessions, listSessions } from './session.service.js';
