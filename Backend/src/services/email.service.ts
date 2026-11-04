import { getQueue } from '../queues/queues.js';
import type { EmailJobData } from '../queues/jobs.js';

/**
 * Email producer — the API process NEVER sends mail inline (docs/ARCHITECTURE.md
 * §12.3): delivery goes through the BullMQ `email` queue with 5 exponential-
 * backoff attempts; failures land in the retained failed set (Bull Board view).
 * Auth flows do not depend on delivery success — enqueue is fire-and-forget.
 */
export async function enqueueEmail(data: EmailJobData): Promise<void> {
  await getQueue('email').add('send', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800 },
  });
}
