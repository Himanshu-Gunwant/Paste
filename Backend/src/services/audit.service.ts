import { prisma } from '../lib/prisma.js';
import { hashToken } from '../lib/tokens.js';
import { logger } from '../lib/logger.js';
import type { ActorType, Prisma } from '../generated/prisma/client.js';

/**
 * Append-only audit trail (docs/ARCHITECTURE.md §4 J). Administrative and
 * moderation actions are recorded with actor snapshots — audit rows survive
 * user deletion (actor FK SET NULL + actorName snapshot).
 */
export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorName: entry.actorName ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        ipHash: entry.ip ? hashToken(entry.ip) : null,
      },
    });
  } catch (err) {
    // Audit writes must never break the primary operation; loud on error.
    logger.error({ err: err instanceof Error ? err.message : err, action: entry.action }, 'audit write failed');
  }
}

/** Fire-and-forget variant for hot paths. */
export function writeAuditAsync(entry: AuditEntry): void {
  void writeAudit(entry);
}
