import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { getQueueConnection } from '../queues/queues.js';
import type { FlushViewsJobData } from '../queues/jobs.js';
import { flushViewDeltas } from '../services/view.service.js';

/**
 * Analytics flush processor (docs/ARCHITECTURE.md §12.2) — repeatable job
 * every 60 s. runId comes from the job itself; the inflight key namespace
 * makes concurrent/crashed runs exactly-once.
 */
export async function processFlushViewsJob(job: Job<FlushViewsJobData>): Promise<void> {
  const runId = job.data.runId || job.id || randomUUID();
  const result = await flushViewDeltas(runId);
  if (result.recovered > 0) {
    logger.warn({ runId, recovered: result.recovered, totalViews: result.totalViews }, 'view flush recovered crashed run');
  }
  if (result.applied > 0) {
    logger.debug({ runId, applied: result.applied, totalViews: result.totalViews }, 'view flush applied');
  }
}

export function startAnalyticsWorker(): Worker<FlushViewsJobData> {
  return new Worker<FlushViewsJobData>('analytics', processFlushViewsJob, {
    connection: getQueueConnection(),
    concurrency: 1, // flush runs are serialized by design
  });
}
