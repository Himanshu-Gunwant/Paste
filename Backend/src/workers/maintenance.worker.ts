import { Worker, type Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getQueueConnection } from '../queues/queues.js';
import { schedulePastePurge } from '../queues/paste-jobs.js';
import { TOMBSTONE_RETENTION_DAYS } from '../config/constants.js';
import { pasteRepository } from '../repositories/paste.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { authTokenRepository } from '../repositories/auth-token.repository.js';
import { flushUniqueVisitors } from '../services/view.service.js';

/**
 * Maintenance sweepers (docs/ARCHITECTURE.md §12.3) — cron-driven, all
 * idempotent, all windowed (LIMIT-capped). The expiry sweeper is the
 * AUTHORITATIVE expiration enforcement: it reads PostgreSQL directly and
 * works with zero Redis state (Redis loss never leaks expired content).
 */

/** §10: tombstone every paste whose expires_at has passed. */
export async function sweepExpiredPastes(now: Date = new Date(), limit = 500): Promise<string[]> {
  const ids = await pasteRepository.tombstoneExpired(now, limit);
  for (const pasteId of ids) {
    await schedulePastePurge(
      pasteId,
      TOMBSTONE_RETENTION_DAYS.SYSTEM * 24 * 60 * 60 * 1000,
    ).catch(() => undefined);
  }
  if (ids.length > 0) {
    logger.info({ count: ids.length }, 'expiry sweeper tombstoned pastes');
  }
  return ids;
}

/** §5.2: hard-delete tombstones past their retention window. */
export async function sweepPurgeTombstones(now: Date = new Date(), limit = 500): Promise<number> {
  const purged = await pasteRepository.purgeTombstones(now, limit);
  if (purged > 0) logger.info({ purged }, 'purge sweeper removed tombstones');
  return purged;
}

export async function sweepSessions(now: Date = new Date()): Promise<number> {
  return sessionRepository.deleteExpiredBefore(now);
}

export async function sweepAuthTokens(now: Date = new Date()): Promise<number> {
  return authTokenRepository.deleteExpiredBefore(now);
}

/** Nightly corrective recompute of the denormalized users.storage_used (§4 K). */
export async function reconcileStorageUsed(): Promise<number> {
  const sums = await prisma.paste.groupBy({
    by: ['authorId'],
    where: { authorId: { not: null }, deletedAt: null },
    _sum: { contentSize: true },
  });
  let corrected = 0;
  for (const row of sums) {
    if (!row.authorId) continue;
    const target = BigInt(row._sum.contentSize ?? 0);
    const user = await prisma.user.findUnique({
      where: { id: row.authorId },
      select: { storageUsed: true },
    });
    if (user && user.storageUsed !== target) {
      await prisma.user.update({ where: { id: row.authorId }, data: { storageUsed: target } });
      corrected += 1;
    }
  }
  if (corrected > 0) logger.info({ corrected }, 'storage-used reconciliation corrected users');
  return corrected;
}

export async function processMaintenanceJob(job: Job): Promise<void> {
  switch (job.name) {
    case 'sweep-expiry':
      await sweepExpiredPastes();
      break;
    case 'sweep-purge':
      await sweepPurgeTombstones();
      break;
    case 'sweep-sessions':
      await sweepSessions();
      break;
    case 'sweep-auth-tokens':
      await sweepAuthTokens();
      break;
    case 'reconcile-storage':
      await reconcileStorageUsed();
      break;
    case 'flush-uniques':
      await flushUniqueVisitors();
      break;
    default:
      logger.warn({ name: job.name }, 'unknown maintenance job');
  }
}

export function startMaintenanceWorker(): Worker {
  return new Worker('maintenance', processMaintenanceJob, {
    connection: getQueueConnection(),
    concurrency: 1,
  });
}
