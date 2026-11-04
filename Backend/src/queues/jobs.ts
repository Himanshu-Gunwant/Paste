/** Typed BullMQ job payloads (docs/ARCHITECTURE.md §12.3). */

export type EmailJobData =
  | { type: 'email_verification'; to: string; username: string; link: string }
  | { type: 'password_reset'; to: string; username: string; link: string };

export interface ExpirePasteJobData {
  pasteId: string;
}

export interface PurgePasteJobData {
  pasteId: string;
}

export interface FlushViewsJobData {
  /** Run identifier — forms the inflight key suffix for crash recovery. */
  runId: string;
}

/** Phase 6+ payloads: moderation heuristics. */
