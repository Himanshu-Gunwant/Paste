import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';
import { pasteRepository } from '../repositories/paste.repository.js';
import { writeAudit } from './audit.service.js';
import type { User } from '../generated/prisma/client.js';

/**
 * Administration (docs/ARCHITECTURE.md §4 J, §7.2 admin catalog). Every
 * action is audited; suspensions revoke all sessions immediately; paste
 * purge is a hard delete. Route access is double-guarded (requireAuth
 * role=ADMIN + service-level admin assertion) and IP-allowlisting for
 * Bull Board stays in Nginx.
 */
export interface AdminActor {
  actor: User;
  ip: string | null;
}

export async function adminStats(): Promise<{
  users: number;
  activeUsers: number;
  livePastes: number;
  openReports: number;
  apiKeys: number;
}> {
  const [users, activeUsers, livePastes, openReports, apiKeys] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.paste.count({ where: { deletedAt: null } }),
    prisma.abuseReport.count({ where: { status: 'OPEN' } }),
    prisma.apiKey.count({ where: { revokedAt: null } }),
  ]);
  return { users, activeUsers, livePastes, openReports, apiKeys };
}

export async function listUsers(q: string | undefined): Promise<
  { id: string; username: string; email: string; status: string; role: string; createdAt: Date }[]
> {
  const rows = await prisma.user.findMany({
    where: q
      ? { OR: [{ username: { contains: q } }, { email: { contains: q } }] }
      : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, username: true, email: true, status: true, role: true, createdAt: true },
  });
  return rows;
}

export async function listPastes(q: string | undefined, deleted: boolean): Promise<
  { id: string; title: string | null; visibility: string; deletedAt: Date | null; authorUsername: string | null; createdAt: Date }[]
> {
  const rows = await prisma.paste.findMany({
    where: {
      ...(deleted ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...(q ? { OR: [{ id: q }, { title: { contains: q } }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { author: { select: { username: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    visibility: row.visibility.toLowerCase(),
    deletedAt: row.deletedAt,
    authorUsername: row.author?.username ?? null,
    createdAt: row.createdAt,
  }));
}

export async function suspendUser(
  admin: AdminActor,
  targetId: string,
  input: { reason: string; endsAt?: Date | null },
): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target || target.deletedAt) throw AppError.notFound('User not found');
  if (target.role === 'ADMIN') throw AppError.forbidden('Cannot suspend an administrator');
  if (target.status === 'SUSPENDED') throw AppError.conflict('User is already suspended');

  await prisma.$transaction(async (tx) => {
    await tx.userRestriction.create({
      data: {
        userId: target.id,
        type: 'SUSPENSION',
        reason: input.reason,
        endsAt: input.endsAt ?? null,
        createdById: admin.actor.id,
      },
    });
    await tx.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await tx.apiKey.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: 'user.suspend',
    targetType: 'user',
    targetId: target.id,
    metadata: { reason: input.reason, endsAt: input.endsAt ?? null },
    ip: admin.ip,
  });
}

export async function unsuspendUser(admin: AdminActor, targetId: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('User not found');

  await prisma.$transaction(async (tx) => {
    await tx.userRestriction.updateMany({
      where: { userId: target.id, type: 'SUSPENSION', liftedAt: null },
      data: { liftedAt: new Date(), liftedById: admin.actor.id },
    });
    await tx.user.update({
      where: { id: target.id },
      data: { status: target.deletedAt ? 'DELETED' : 'ACTIVE' },
    });
  });
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: 'user.unsuspend',
    targetType: 'user',
    targetId: target.id,
    ip: admin.ip,
  });
}

export async function hardPurgePaste(admin: AdminActor, pasteId: string): Promise<void> {
  const count = await pasteRepository.deleteHard(pasteId);
  if (count === 0) throw AppError.notFound('Paste not found');
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: 'paste.purge',
    targetType: 'paste',
    targetId: pasteId,
    ip: admin.ip,
  });
}

export type ResolveAction = 'delete_paste' | 'dismiss';

export async function resolveReport(
  admin: AdminActor,
  reportId: string,
  input: { action: ResolveAction; note?: string },
): Promise<void> {
  const report = await prisma.abuseReport.findUnique({ where: { id: reportId } });
  if (!report) throw AppError.notFound('Report not found');
  if (report.status === 'RESOLVED' || report.status === 'DISMISSED') {
    throw AppError.conflict('Report is already resolved');
  }

  if (input.action === 'delete_paste') {
    const count = await pasteRepository.softDelete(report.pasteId, 'MODERATOR');
    if (count > 0) {
      await writeAudit({
        actorType: 'ADMIN',
        actorId: admin.actor.id,
        actorName: admin.actor.username,
        action: 'paste.moderator_delete',
        targetType: 'paste',
        targetId: report.pasteId,
        metadata: { reportId },
        ip: admin.ip,
      });
    }
  }

  await prisma.abuseReport.update({
    where: { id: report.id },
    data: {
      status: input.action === 'delete_paste' ? 'RESOLVED' : 'DISMISSED',
      resolutionNote: input.note?.slice(0, 2000) ?? null,
      handledById: admin.actor.id,
      resolvedAt: new Date(),
    },
  });
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: `report.${input.action}`,
    targetType: 'report',
    targetId: report.id,
    metadata: { pasteId: report.pasteId },
    ip: admin.ip,
  });
}

export async function listReports(status?: 'OPEN' | 'REVIEWED' | 'RESOLVED' | 'DISMISSED'): Promise<
  { id: string; pasteId: string; reason: string; status: string; details: string | null; createdAt: Date; reporterId: string | null }[]
> {
  return prisma.abuseReport.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      pasteId: true,
      reason: true,
      status: true,
      details: true,
      createdAt: true,
      reporterId: true,
    },
  });
}

export async function listAuditLogs(limit: number, offset: number): Promise<{
  data: {
    id: string;
    actorType: string;
    actorName: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: Date;
  }[];
  hasMore: boolean;
}> {
  const rows = await prisma.auditLog.findMany({
    orderBy: { id: 'desc' },
    take: Math.min(limit, 200),
    skip: offset,
    select: {
      id: true,
      actorType: true,
      actorName: true,
      action: true,
      targetType: true,
      targetId: true,
      createdAt: true,
    },
  });
  return { data: rows.map((row) => ({ ...row, id: row.id.toString() })), hasMore: rows.length === Math.min(limit, 200) };
}

export async function createIpBan(
  admin: AdminActor,
  input: { ip: string; reason: string; expiresAt?: Date | null },
): Promise<void> {
  const existing = await prisma.ipBan.findUnique({ where: { ipHash: hashToken(input.ip) } });
  if (existing) throw AppError.conflict('IP is already banned');
  await prisma.ipBan.create({
    data: {
      ipHash: hashToken(input.ip),
      reason: input.reason,
      createdById: admin.actor.id,
      expiresAt: input.expiresAt ?? null,
    },
  });
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: 'ip.ban',
    targetType: 'ip_ban',
    targetId: hashToken(input.ip).slice(0, 16),
    metadata: { reason: input.reason, expiresAt: input.expiresAt ?? null },
    ip: admin.ip,
  });
}

export async function deleteIpBan(admin: AdminActor, id: string): Promise<void> {
  const removed = await prisma.ipBan.deleteMany({ where: { id } });
  if (removed.count === 0) throw AppError.notFound('IP ban not found');
  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin.actor.id,
    actorName: admin.actor.username,
    action: 'ip.unban',
    targetType: 'ip_ban',
    targetId: id,
    ip: admin.ip,
  });
}

export async function listIpBans(): Promise<
  { id: string; ipHash: string; reason: string; expiresAt: Date | null; createdAt: Date }[]
> {
  return prisma.ipBan.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, ipHash: true, reason: true, expiresAt: true, createdAt: true },
  });
}

/** Upload gate (§4 J): active SUSPENSION or UPLOAD_BAN blocks paste creation. */
export async function assertNotUploadBanned(userId: string): Promise<void> {
  const active = await prisma.userRestriction.findFirst({
    where: {
      userId,
      liftedAt: null,
      type: { in: ['SUSPENSION', 'UPLOAD_BAN'] },
      OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
    },
    select: { type: true, reason: true },
  });
  if (active) {
    throw AppError.forbidden(
      active.type === 'UPLOAD_BAN'
        ? 'You are banned from creating pastes'
        : 'This account is suspended',
    );
  }
}

/** Anonymous write-path IP guard (§4 J) — exact hash match, active only. */
export async function isIpBanned(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const ban = await prisma.ipBan.findUnique({ where: { ipHash: hashToken(ip) } });
  if (!ban) return false;
  return ban.expiresAt === null || ban.expiresAt > new Date();
}
