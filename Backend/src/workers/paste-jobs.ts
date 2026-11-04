import { Worker, type Job } from 'bullmq';
import { TOMBSTONE_RETENTION_DAYS } from '../config/constants.js';
import { logger } from '../lib/logger.js';
import { getQueueConnection } from '../queues/queues.js';
import { schedulePastePurge } from '../queues/paste-jobs.js';
import type { ExpirePasteJobData, PurgePasteJobData } from '../queues/jobs.js';
import { pasteRepository } from '../repositories/paste.repository.js';

/**
 * Paste lifecycle processors (docs/ARCHITECTURE.md §10). Both are idempotent
 * by construction — state-guarded SQL means re-runs and duplicate jobs are
 * no-ops, and the sweepers make queue loss harmless.
 */

/** Tombstone an expired paste (content nulled) + schedule the purge. */
export async function processExpireJob(job: Job<ExpirePasteJobData>): Promise<void> {
  const count = await pasteRepository.softDelete(job.data.pasteId, 'SYSTEM');
  if (count > 0) {
    await schedulePastePurge(
      job.data.pasteId,
      TOMBSTONE_RETENTION_DAYS.SYSTEM * 24 * 60 * 60 * 1000,
    );
    logger.info({ jobId: job.id, pasteId: job.data.pasteId }, 'paste expired; tombstoned');
  }
  // 0 rows = already tombstoned (sweeper raced us) — success either way.
}

/** Hard-delete a tombstoned paste (revisions/views/tokens cascade). */
export async function processPurgeJob(job: Job<PurgePasteJobData>): Promise<void> {
  const count = await pasteRepository.deleteHard(job.data.pasteId);
  logger.info({ jobId: job.id, pasteId: job.data.pasteId, deleted: count }, 'paste purge');
}

export function startExpireWorker(): Worker<ExpirePasteJobData> {
  return new Worker<ExpirePasteJobData>('expire', processExpireJob, {
    connection: getQueueConnection(),
    concurrency: 5,
  });
}

export function startPurgeWorker(): Worker<PurgePasteJobData> {
  return new Worker<PurgePasteJobData>('purge', processPurgeJob, {
    connection: getQueueConnection(),
    concurrency: 5,
  });
}
