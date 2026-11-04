import type { ApiUsageEntry } from '../repositories/api-usage.repository.js';
import { apiUsageRepository } from '../repositories/api-usage.repository.js';
import { logger } from '../lib/logger.js';

/**
 * API usage capture (docs/ARCHITECTURE.md §4 H): per-request entries are
 * buffered in-process and flushed in batches — the response path never
 * awaits a DB write. Bounded buffer (drop-oldest) protects memory under
 * burst; a crash loses at most one flush window of usage telemetry.
 */
const BUFFER_MAX = 5_000;

let buffer: ApiUsageEntry[] = [];

export function recordApiUsage(entry: ApiUsageEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) {
    buffer = buffer.slice(-BUFFER_MAX); // drop oldest under burst
  }
}

export async function flushApiUsage(): Promise<number> {
  if (buffer.length === 0) return 0;
  const batch = buffer;
  buffer = [];
  try {
    return await apiUsageRepository.insertMany(batch);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, count: batch.length }, 'api usage flush failed');
    return 0;
  }
}

export function pendingApiUsageCount(): number {
  return buffer.length;
}
