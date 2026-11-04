import { prisma } from '../lib/prisma.js';
import { deletedEmailFor } from '../config/constants.js';
import type { User } from '../generated/prisma/client.js';

/** All User persistence goes through this repository (docs/ARCHITECTURE.md §14). */
export const userRepository = {
  findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  },

  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  },

  findByUsername(username: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { username } });
  },

  create(data: {
    email: string;
    username: string;
    passwordHash: string | null;
    emailVerified?: boolean;
    displayName?: string | null;
    avatarUrl?: string | null;
  }): Promise<User> {
    return prisma.user.create({ data: { ...data, emailVerified: data.emailVerified ?? false } });
  },

  updateProfile(
    id: string,
    patch: { displayName?: string | null; bio?: string | null; avatarUrl?: string | null; websiteUrl?: string | null },
  ): Promise<User> {
    return prisma.user.update({ where: { id }, data: patch });
  },

  setVerified(id: string): Promise<User> {
    return prisma.user.update({ where: { id }, data: { emailVerified: true } });
  },

  setPasswordHash(id: string, passwordHash: string | null): Promise<User> {
    return prisma.user.update({ where: { id }, data: { passwordHash } });
  },

  /**
   * Soft-delete + PII scrub (docs/ARCHITECTURE.md §4 D, §5.2): email is
   * released via the invalid marker, profile fields anonymized. Pastes and
   * other user content cascade once those tables exist (Phase 2+ FK CASCADE).
   */
  anonymizeAndDelete(id: string): Promise<User> {
    return prisma.user.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        email: deletedEmailFor(id),
        displayName: null,
        bio: null,
        avatarUrl: null,
        websiteUrl: null,
        passwordHash: null,
      },
    });
  },
};
