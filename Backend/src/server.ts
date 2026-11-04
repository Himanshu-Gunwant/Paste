import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePrisma } from './lib/prisma.js';
import { closeRedis } from './lib/redis.js';

/**
 * API process entrypoint (docs/ARCHITECTURE.md §17 — graceful shutdown).
 * SIGTERM/SIGINT: stop accepting → drain in-flight → close Redis/PG.
 * Later phases insert queue draining and view-delta flushing before the
 * dependency teardown.
 *
 * Under PM2 fork×2 each instance offsets its port by NODE_APP_INSTANCE
 * (3000/3001 — matches the Nginx upstream). Direct `node dist/server.js`
 * runs on PORT untouched.
 */
const portOffset = process.env.NODE_APP_INSTANCE
  ? Number.parseInt(process.env.NODE_APP_INSTANCE, 10)
  : 0;
const port = Number.isFinite(portOffset) ? env.PORT + portOffset : env.PORT;

const app = createApp();
const server = app.listen(port, () => {
  logger.info({ port, nodeEnv: env.NODE_ENV }, 'API listening');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Force-exit guard so a stuck connection can never hang PM2 past kill_timeout.
  const forceExitTimer = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRedis();
    await closePrisma();
    clearTimeout(forceExitTimer);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});
