import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { redisConnectionOptions } from '../lib/redis.js';

/**
 * BullMQ queue definitions and producers (docs/ARCHITECTURE.md §12.3).
 * Queues are created lazily so importing this module has no side effects;
 * the connection reuses the shared ioredis settings (maxRetriesPerRequest:
 * null is mandatory for BullMQ).
 */
export const QUEUE_NAMES = ['expire', 'purge', 'analytics', 'email', 'maintenance', 'moderation'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Default job options per §12.3 — per-queue overrides applied at add-time. */
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  // Failed jobs are retained (our dead-letter view) and surface via the
  // failed-jobs gauge + Bull Board; sweepers make queue loss non-critical.
  removeOnFail: { age: 2_592_000 },
};

let connection: Redis | null = null;

export function getQueueConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.REDIS_URL, redisConnectionOptions);
  }
  return connection;
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, {
    connection: getQueueConnection(),
    defaultJobOptions,
  });
  queues.set(name, queue);
  return queue;
}

/**
 * Repeatable jobs are re-registered idempotently at worker boot (fixed repeat
 * keys — docs/ARCHITECTURE.md §12.3 "job reconstruction"): after a total
 * Redis loss, boot re-creates every schedule; the sweepers make the queued
 * jobs themselves non-correctness-bearing.
 */
export async function registerRepeatableJobs(): Promise<void> {
  const maintenance = getQueue('maintenance');
  const schedules: { name: string; repeat: { pattern?: string; every?: number } }[] = [
    { name: 'sweep-expiry', repeat: { pattern: '*/5 * * * *' } }, // 5 min — AUTHORITATIVE expiry (§10)
    { name: 'sweep-purge', repeat: { pattern: '10 * * * *' } }, // hourly
    { name: 'sweep-sessions', repeat: { pattern: '20 * * * *' } },
    { name: 'sweep-auth-tokens', repeat: { pattern: '25 * * * *' } },
    { name: 'reconcile-storage', repeat: { pattern: '0 4 * * *' } }, // nightly
    { name: 'flush-uniques', repeat: { pattern: '40 * * * *' } }, // hourly HLL
    { name: 'recompute-trending', repeat: { pattern: '*/5 * * * *' } }, // §4 G
  ];
  for (const schedule of schedules) {
    await maintenance.add(schedule.name, {}, { repeat: schedule.repeat });
  }

  // View-delta flush — 60 s cadence (§12.2).
  await getQueue('analytics').add(
    'flush-views',
    {},
    { repeat: { every: 60_000 } },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  if (connection) {
    const conn = connection;
    connection = null;
    await conn.quit().catch(() => conn.disconnect());
  }
}
