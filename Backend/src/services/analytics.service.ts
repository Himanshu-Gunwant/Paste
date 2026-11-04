import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

/**
 * Analytics reads (docs/ARCHITECTURE.md §4 K): aggregated from
 * paste_view_daily + denormalized counters — never raw per-view scans.
 */
export interface DailyStat {
  day: Date;
  views: number;
  uniqueVisitors: number;
}

export interface PasteStats {
  totals: { views: string; uniqueVisitors: string };
  daily: DailyStat[];
}

export async function getPasteStats(pasteId: string): Promise<PasteStats> {
  const [totals, daily] = await Promise.all([
    prisma.paste.findUnique({
      where: { id: pasteId },
      select: { viewCount: true },
    }),
    prisma.pasteViewDaily.findMany({
      where: { pasteId },
      orderBy: { day: 'desc' },
      take: 30,
    }),
  ]);
  if (!totals) throw AppError.notFound();

  const uniqueSum = await prisma.pasteViewDaily.aggregate({
    where: { pasteId },
    _sum: { uniqueVisitors: true },
  });

  return {
    totals: {
      views: totals.viewCount.toString(),
      uniqueVisitors: (uniqueSum._sum.uniqueVisitors ?? 0n).toString(),
    },
    daily: daily.map((row) => ({
      day: row.day,
      views: Number(row.views),
      uniqueVisitors: Number(row.uniqueVisitors),
    })),
  };
}

export interface UserAnalytics {
  totals: {
    pastes: number;
    storageUsed: string;
    views: string;
    uniqueVisitors: string;
  };
  daily: DailyStat[];
}

export async function getUserAnalytics(authorId: string): Promise<UserAnalytics> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pasteTotals, uniqueSum, daily] = await Promise.all([
    prisma.paste.aggregate({
      where: { authorId, deletedAt: null },
      _count: { id: true },
      _sum: { viewCount: true },
    }),
    prisma.pasteViewDaily.aggregate({
      where: { paste: { authorId, deletedAt: null } },
      _sum: { uniqueVisitors: true },
    }),
    prisma.$queryRaw<{ day: Date; views: bigint; uniques: bigint }[]>`
      SELECT pv.day, SUM(pv.views) AS views, SUM(pv.unique_visitors) AS uniques
      FROM paste_view_daily pv
      JOIN pastes p ON p.id = pv.paste_id
      WHERE p.author_id = ${authorId}
        AND p.deleted_at IS NULL
        AND pv.day >= ${since}
      GROUP BY pv.day
      ORDER BY pv.day DESC
      LIMIT 30
    `,
  ]);

  const user = await prisma.user.findUnique({
    where: { id: authorId },
    select: { storageUsed: true },
  });

  return {
    totals: {
      pastes: pasteTotals._count.id,
      storageUsed: (user?.storageUsed ?? 0n).toString(),
      views: (pasteTotals._sum.viewCount ?? 0n).toString(),
      uniqueVisitors: (uniqueSum._sum.uniqueVisitors ?? 0n).toString(),
    },
    daily: daily.map((row) => ({
      day: new Date(row.day),
      views: Number(row.views),
      uniqueVisitors: Number(row.uniques),
    })),
  };
}
