import { z } from 'zod';

export interface ReportBody {
  pasteId: string;
  reason: 'SPAM' | 'MALWARE' | 'HARASSMENT' | 'COPYRIGHT' | 'OTHER';
  details?: string;
}

export const reportSchema = z.object({
  pasteId: z.string().min(3).max(64),
  reason: z.enum(['SPAM', 'MALWARE', 'HARASSMENT', 'COPYRIGHT', 'OTHER']),
  details: z.string().trim().max(4000).optional(),
});

export interface UserIdParams {
  id: string;
}

export const userIdParamsSchema = z.object({
  id: z.uuid(),
});

export interface PasteIdParams {
  id: string;
}

export const pasteIdParamsSchema = z.object({
  id: z.string().min(3).max(64),
});

export interface SuspendBody {
  reason: string;
  endsAt?: string;
}

export const suspendSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  endsAt: z.iso.datetime().optional(),
});

export interface ResolveReportBody {
  action: 'delete_paste' | 'dismiss';
  note?: string;
}

export const resolveReportSchema = z.object({
  action: z.enum(['delete_paste', 'dismiss']),
  note: z.string().trim().max(2000).optional(),
});

export interface ReportIdParams {
  id: string;
}

export const reportIdParamsSchema = z.object({
  id: z.uuid(),
});

export interface CreateIpBanBody {
  ip: string;
  reason: string;
  expiresAt?: string;
}

export const createIpBanSchema = z.object({
  ip: z.string().min(3).max(45),
  reason: z.string().trim().min(1).max(1000),
  expiresAt: z.iso.datetime().optional(),
});

export const ipBanIdParamsSchema = z.object({
  id: z.uuid(),
});

export const adminListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  deleted: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  status: z.enum(['OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
