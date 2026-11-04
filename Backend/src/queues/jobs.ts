/** Typed BullMQ job payloads (docs/ARCHITECTURE.md §12.3). */

export type EmailJobData =
  | { type: 'email_verification'; to: string; username: string; link: string }
  | { type: 'password_reset'; to: string; username: string; link: string };

/** Phase 2+ payloads: expire, purge, analytics flush, moderation heuristics. */
