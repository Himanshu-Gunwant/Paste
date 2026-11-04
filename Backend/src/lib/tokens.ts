import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token and identifier generation (docs/ARCHITECTURE.md §4 A/B, §5.2).
 * All credentials are CSPRNG-generated, stored only as SHA-256 hashes and
 * compared timing-safely. Raw values are shown to users exactly once.
 */

const PASTE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const PASTE_ID_LENGTH = 10;

/** Raw bearer/management/share/reset token: 32 bytes, base64url (43 chars). */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Canonical storage form for every token and API key (SHA-256 hex, 64 chars). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Timing-safe verification of a raw candidate against a stored hash. */
export function verifyToken(candidate: string, storedHashHex: string): boolean {
  const candidateHash = Buffer.from(hashToken(candidate), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== candidateHash.length) return false;
  return timingSafeEqual(candidateHash, stored);
}

/**
 * Public paste identifier: 10 chars from an unambiguous 56-char alphabet
 * (excludes 0, O, 1, l, I) — 56^10 ≈ 3×10^17. Rejection sampling keeps the
 * distribution uniform without modulo bias. Callers retry on the rare unique-
 * constraint collision (≤ 3 attempts, per architecture).
 */
export function generatePasteId(): string {
  const alphabetLength = PASTE_ID_ALPHABET.length; // 56
  const maxUsable = 256 - (256 % alphabetLength);
  let id = '';
  while (id.length < PASTE_ID_LENGTH) {
    const bytes = randomBytes(PASTE_ID_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= maxUsable) continue;
      id += PASTE_ID_ALPHABET.charAt(byte % alphabetLength);
      if (id.length === PASTE_ID_LENGTH) break;
    }
  }
  return id;
}
