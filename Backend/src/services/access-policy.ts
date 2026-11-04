import type { Paste } from '../generated/prisma/client.js';
import type { AuthContext } from '../types/auth.js';

/**
 * Central paste authorization (docs/ARCHITECTURE.md §4 B) — the single
 * decision point every paste read/manage path must pass through.
 * Obscurity of identifiers is NEVER authorization; private/unlisted are
 * decided here, and all listing queries additionally filter visibility
 * at the database level.
 */
export interface PasteViewContext {
  auth: AuthContext;
  /** Verified SHARE token bound to this paste (service verifies the hash first). */
  shareTokenVerified?: boolean;
  /** Verified MANAGEMENT token (anonymous owner-equivalent credential). */
  managementTokenVerified?: boolean;
}

export type PasteViewDecision =
  | { outcome: 'ALLOW' }
  | { outcome: 'PASSWORD_REQUIRED' }
  | { outcome: 'NOT_FOUND' };

function principal(ctx: PasteViewContext) {
  return ctx.auth.kind === 'anonymous' ? null : ctx.auth.user;
}

function isOwnerOrEquivalent(paste: Paste, ctx: PasteViewContext): boolean {
  const user = principal(ctx);
  return (user !== null && paste.authorId === user.id) || ctx.managementTokenVerified === true;
}

export function authorizePasteView(paste: Paste, ctx: PasteViewContext): PasteViewDecision {
  const user = principal(ctx);
  const isAdmin = user?.role === 'ADMIN';

  if (isOwnerOrEquivalent(paste, ctx) || isAdmin) return { outcome: 'ALLOW' };

  if (paste.visibility === 'PRIVATE') {
    // Share tokens grant read access to private pastes (password still applies).
    if (!ctx.shareTokenVerified) return { outcome: 'NOT_FOUND' };
  }

  if (paste.passwordHash) return { outcome: 'PASSWORD_REQUIRED' };
  return { outcome: 'ALLOW' };
}

/**
 * Manage authorization (update/delete/fork-management). Unlisted/private
 * ownership leaks nothing: false maps to the uniform 404 envelope (§20.2).
 */
export function authorizePasteManage(paste: Paste, ctx: PasteViewContext): boolean {
  const user = principal(ctx);
  const isAdmin = user?.role === 'ADMIN';
  return isOwnerOrEquivalent(paste, ctx) || isAdmin;
}
