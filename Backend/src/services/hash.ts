import { createHash } from 'node:crypto';

/** Canonical content hash (SHA-256 hex) used for revisions and abuse clustering. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
