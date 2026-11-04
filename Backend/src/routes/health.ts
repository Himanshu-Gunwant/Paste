import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Health endpoints (unversioned; docs/ARCHITECTURE.md §16).
 * /healthz — liveness: process is up (no dependency checks; PM2 restarts on failure to respond).
 * /readyz  — readiness: PostgreSQL + Redis reachable. Load balancer/deploys gate on this.
 */
export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
});

healthRouter.get('/readyz', async (_req, res) => {
  const checks = { database: false, redis: false };
  let degraded = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (err) {
    degraded = true;
    logger.error({ err: err instanceof Error ? err.message : err }, 'readiness: database check failed');
  }

  try {
    const pong = await getRedis().ping();
    checks.redis = pong === 'PONG';
    if (!checks.redis) degraded = true;
  } catch (err) {
    degraded = true;
    logger.error({ err: err instanceof Error ? err.message : err }, 'readiness: redis check failed');
  }

  res.status(degraded ? 503 : 200).json({ status: degraded ? 'degraded' : 'ready', checks });
});
