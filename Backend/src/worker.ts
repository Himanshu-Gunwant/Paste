import 'dotenv/config';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePrisma } from './lib/prisma.js';
import { closeRedis, getRedis } from './lib/redis.js';
import { closeQueues, getQueueConnection, registerRepeatableJobs } from './queues/queues.js';
import { startEmailWorker } from './workers/email.worker.js';
import { startExpireWorker, startPurgeWorker } from './workers/paste-jobs.js';
import { startAnalyticsWorker } from './workers/analytics.worker.js';
import { startMaintenanceWorker } from './workers/maintenance.worker.js';
import type { Worker } from 'bullmq';

/**
 * Worker process entrypoint (docs/ARCHITECTURE.md §12.3, §17).
 * Repeatable schedules are re-registered at boot (Redis-loss recovery);
 * the expiry sweeper is the authoritative expiration enforcement.
 */
let workers: Worker[] = [];

async function main(): Promise<void> {
  await getQueueConnection().ping();
  await getRedis().ping();
  await registerRepeatableJobs();

  workers = [
    startEmailWorker(),
    startExpireWorker(),
    startPurgeWorker(),
    startAnalyticsWorker(),
    startMaintenanceWorker(),
  ];
  logger.info(
    { nodeEnv: env.NODE_ENV, workers: workers.map((w) => w.name) },
    'worker started',
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');

  const forceExitTimer = setTimeout(() => {
    logger.error('worker shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);

  try {
    // Bounded drain: wait for in-flight jobs up to 30 s (docs/ARCHITECTURE.md §17).
    const draining = workers.map((worker) => worker.close());
    workers = [];
    await Promise.race([Promise.allSettled(draining), delay(30_000)]);
    await closeQueues();
    await closeRedis();
    await closePrisma();
    clearTimeout(forceExitTimer);
    logger.info('worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'worker: unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'worker: uncaught exception');
  void shutdown('uncaughtException');
});

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
