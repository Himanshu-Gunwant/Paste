import { prisma } from '../lib/prisma.js';

export interface ApiUsageEntry {
  apiKeyId: string | null;
  userId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
}

/** Append-only API request log (docs/ARCHITECTURE.md §4 H) — batch inserts. */
export const apiUsageRepository = {
  insertMany(entries: ApiUsageEntry[]): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    return prisma.apiUsage.createMany({ data: entries }).then((r) => r.count);
  },

  /** Maintenance sweep (§12.3): 90-day retention. */
  deleteOlderThan(date: Date): Promise<number> {
    return prisma.apiUsage.deleteMany({ where: { createdAt: { lt: date } } }).then((r) => r.count);
  },

  summarizeForUser(
    userId: string,
    since: Date,
  ): Promise<{ apiKeyId: string | null; requests: number; avgLatencyMs: number }[]> {
    return prisma.apiUsage
      .groupBy({
        by: ['apiKeyId'],
        where: { userId, createdAt: { gte: since } },
        _count: { id: true },
        _avg: { latencyMs: true },
      })
      .then((rows) =>
        rows.map((row) => ({
          apiKeyId: row.apiKeyId,
          requests: row._count.id,
          avgLatencyMs: Math.round(row._avg.latencyMs ?? 0),
        })),
      );
  },
};
