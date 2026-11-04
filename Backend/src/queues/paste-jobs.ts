import type { ExpirePasteJobData, PurgePasteJobData } from './jobs.js';
import { getQueue } from './queues.js';

/**
 * Paste lifecycle job producers (docs/ARCHITECTURE.md §10).
 * Deterministic jobIds make scheduling idempotent: re-scheduling replaces,
 * never duplicates. Delays are capped at 6 days — BullMQ/Node timers cannot
 * span longer horizons reliably, and the 5-minute sweeper is the
 * AUTHORITATIVE enforcement anyway (works with zero Redis state).
 */
const MAX_JOB_DELAY_MS = 6 * 24 * 60 * 60 * 1000;

export async function schedulePasteExpiration(pasteId: string, expiresAt: Date): Promise<void> {
  const delay = Math.max(0, Math.min(expiresAt.getTime() - Date.now(), MAX_JOB_DELAY_MS));
  await getQueue('expire').add('expire', { pasteId } satisfies ExpirePasteJobData, {
    jobId: `exp:${pasteId}`,
    delay,
  });
}

export async function cancelPasteExpiration(pasteId: string): Promise<void> {
  const job = await getQueue('expire').getJob(`exp:${pasteId}`);
  if (job) await job.remove().catch(() => undefined);
}

export async function schedulePastePurge(pasteId: string, delayMs: number): Promise<void> {
  const delay = Math.max(0, Math.min(delayMs, MAX_JOB_DELAY_MS));
  await getQueue('purge').add('purge', { pasteId } satisfies PurgePasteJobData, {
    jobId: `purge:${pasteId}`,
    delay,
  });
}
