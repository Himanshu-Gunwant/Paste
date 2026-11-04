import type { User } from '../generated/prisma/client.js';

/**
 * Resolved authentication context (docs/ARCHITECTURE.md §7.1).
 * Middleware only RESOLVES the context; authorization decisions are made in
 * services (AccessPolicy / per-resource ownership checks).
 * The apiKey variant arrives with Phase 5 — declared now so call sites can
 * pattern-match exhaustively from the start.
 */
export type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'session'; sessionId: string; user: User }
  | { kind: 'apiKey'; apiKeyId: string; user: User };

export const ANONYMOUS: AuthContext = { kind: 'anonymous' } as const;
