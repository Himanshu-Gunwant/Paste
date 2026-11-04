import { AppError } from '../lib/errors.js';
import { verifyPassword } from '../lib/crypto.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { authTokenRepository } from '../repositories/auth-token.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import type { User } from '../generated/prisma/client.js';

/** Public profile projection — never includes email (docs/ARCHITECTURE.md §4 D). */
export interface PublicProfile {
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  websiteUrl: string | null;
  createdAt: Date;
}

export function toPublicProfile(user: User): PublicProfile {
  return {
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    websiteUrl: user.websiteUrl,
    createdAt: user.createdAt,
  };
}

/** Self projection — includes email but never the password hash. */
export function toCurrentUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    websiteUrl: user.websiteUrl,
    emailVerified: user.emailVerified,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export async function getMe(userId: string): Promise<User> {
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt || user.status !== 'ACTIVE') throw AppError.unauthorized();
  return user;
}

export async function updateMe(
  userId: string,
  patch: { displayName?: string | null; bio?: string | null; avatarUrl?: string | null; websiteUrl?: string | null },
): Promise<User> {
  await getMe(userId); // must be an active, non-deleted account
  return userRepository.updateProfile(userId, patch);
}

export async function getPublicProfile(username: string): Promise<PublicProfile> {
  const user = await userRepository.findByUsername(username.toLowerCase());
  // Uniform 404 for missing/deleted/suspended profiles (anti-enumeration).
  if (!user || user.deletedAt || user.status !== 'ACTIVE') throw AppError.notFound('User not found');
  return toPublicProfile(user);
}

/**
 * Account deletion (docs/ARCHITECTURE.md §4 D): password re-confirmation
 * (skipped for OAuth-only accounts), PII scrub + soft delete, then all
 * sessions and auth tokens revoked. Pastes/content cascade via FK once
 * Phase 2 tables exist.
 */
export async function deleteAccount(userId: string, password: string | null): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt || user.status !== 'ACTIVE') throw AppError.unauthorized();

  if (user.passwordHash !== null) {
    const ok = await verifyPassword(user.passwordHash, password ?? '');
    if (!ok) throw AppError.unauthorized('Password confirmation failed');
  }

  await userRepository.anonymizeAndDelete(userId);
  await sessionRepository.deleteAllForUser(userId);
  await authTokenRepository.deleteAllForUser(userId);
}
