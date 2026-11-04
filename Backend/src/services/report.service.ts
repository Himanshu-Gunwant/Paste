import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';
import { writeAudit } from './audit.service.js';
import type { AuthContext } from '../types/auth.js';

/** Auto-unlist threshold: this many OPEN reports flips a PUBLIC paste to unlisted. */
const AUTO_UNLIST_OPEN_REPORTS = 3;

/** Duplicate-content cluster size that flags a paste for review (log-only). */
const DUPLICATE_CLUSTER_THRESHOLD = 5;

export interface CreateReportInput {
  pasteId: string;
  reason: 'SPAM' | 'MALWARE' | 'HARASSMENT' | 'COPYRIGHT' | 'OTHER';
  details?: string;
}

/**
 * Abuse reports (docs/ARCHITECTURE.md §4 J): anonymous-allowed, IP-hashed,
 * rate-limited upstream. The auto-unlist heuristic flips PUBLIC pastes with
 * enough OPEN reports to unlisted pending review — moderation still decides.
 */
export async function createReport(
  input: CreateReportInput,
  auth: AuthContext,
  ip: string | null,
): Promise<{ id: string; status: string }> {
  const paste = await prisma.paste.findFirst({
    where: {
      id: input.pasteId,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, visibility: true, contentHash: true, authorId: true },
  });
  if (!paste) throw AppError.notFound('Paste not found');

  // Self-reports are pointless but harmless; reporters are rate-limited.
  const report = await prisma.abuseReport.create({
    data: {
      pasteId: paste.id,
      reporterId: auth.kind === 'anonymous' ? null : auth.user.id,
      reporterIpHash: hashToken(ip ?? 'unknown'),
      reason: input.reason,
      details: input.details?.slice(0, 4000) ?? null,
    },
  });

  const openCount = await prisma.abuseReport.count({
    where: { pasteId: paste.id, status: 'OPEN' },
  });
  if (openCount >= AUTO_UNLIST_OPEN_REPORTS && paste.visibility === 'PUBLIC') {
    await prisma.paste.update({
      where: { id: paste.id },
      data: { visibility: 'UNLISTED' },
    });
    await writeAudit({
      actorType: 'SYSTEM',
      action: 'paste.auto_unlist',
      targetType: 'paste',
      targetId: paste.id,
      metadata: { openReports: openCount },
      ip,
    });
  }

  // Cheap duplicate-content signal (§4 J).
  const duplicates = await prisma.paste.count({
    where: { contentHash: paste.contentHash, deletedAt: null, id: { not: paste.id } },
  });
  if (duplicates >= DUPLICATE_CLUSTER_THRESHOLD) {
    await writeAudit({
      actorType: 'SYSTEM',
      action: 'paste.duplicate_cluster',
      targetType: 'paste',
      targetId: paste.id,
      metadata: { clusterSize: duplicates + 1 },
      ip,
    });
  }

  return { id: report.id, status: report.status };
}
