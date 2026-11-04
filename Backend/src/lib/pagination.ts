import { AppError } from './errors.js';

/**
 * Keyset (cursor) pagination codec (docs/ARCHITECTURE.md §7.1, §18).
 * Cursor = base64url(JSON) of the sort key tuple; opaque to clients.
 */
export interface KeysetCursor {
  /** ISO timestamp of the sort column (created_at for latest/search). */
  t: string;
  /** Tiebreaker id. */
  id: string;
  /** Optional numeric sort value (view_count for popular). */
  v?: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw AppError.validation('Invalid pagination cursor');
  }
  const candidate = parsed as { t?: unknown; id?: unknown; v?: unknown };
  if (
    !candidate ||
    typeof candidate.t !== 'string' ||
    typeof candidate.id !== 'string' ||
    Number.isNaN(Date.parse(candidate.t))
  ) {
    throw AppError.validation('Invalid pagination cursor');
  }
  const cursor: KeysetCursor = { t: candidate.t, id: candidate.id };
  if (typeof candidate.v === 'string') cursor.v = candidate.v;
  return cursor;
}

export interface PaginationResult {
  cursor?: string;
  hasMore: boolean;
}

/** Builds the next-page envelope from the last row of the current page. */
export function buildPagination(
  rows: { createdAt: Date; id: string; viewCount?: bigint }[],
  limit: number,
): PaginationResult {
  if (rows.length < limit) return { hasMore: false };
  const last = rows[rows.length - 1]!;
  const cursor: KeysetCursor = { t: last.createdAt.toISOString(), id: last.id };
  if (last.viewCount !== undefined) cursor.v = last.viewCount.toString();
  return { cursor: encodeCursor(cursor), hasMore: true };
}
