import 'dotenv/config';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePrisma } from './lib/prisma.js';
import { closeRedis, getRedis } from './lib/redis.js';
import { closeQueues, getQueueConnection, registerRepeatableJobs } from './queues/queues.js';

/**
 * Worker process entrypoint (docs/ARCHITECTURE.md §12.3, §17).
 * Responsibilities by phase:
 *   Phase 2: expire/purge/analytics processors, expiry sweeper (5 min, authoritative),
 *            repeatable registration (boot re-registration for Redis-loss recovery)
 *   Phase 1: email processor
 *   Phase 8: moderation processor
 * Phase 0 boots the wiring and verifies dependencies.
 */
async function main(): Promise<void> {
  await getQueueConnection().ping();
  await getRedis().ping();
  await registerRepeatableJobs();
  logger.info({ nodeEnv: env.NODE_ENV }, 'worker started');
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
    // Phase 2+ awaits BullMQ worker.close() here (bounded 30 s) before teardown.
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
