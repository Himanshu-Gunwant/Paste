import argon2 from 'argon2';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../config/constants.js';

/**
 * Password hashing — Argon2id with OWASP baseline parameters
 * (m = 19 MiB, t = 2, p = 1; docs/ARCHITECTURE.md §13).
 * Login paths MUST go through verifyPassword so unknown emails consume the
 * same argon2 work as known ones (timing-equalization dummy hash).
 */
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('timing-equalization-dummy-input', ARGON2_OPTS);
  return dummyHashPromise;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

/**
 * Verifies a password against a stored hash. When no hash exists (unknown
 * account, or OAuth-only user) the same argon2 work is performed against a
 * dummy hash and false is returned — response timing does not reveal
 * whether the email exists.
 */
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!hash) {
    await argon2.verify(await getDummyHash(), password);
    return false;
  }
  return argon2.verify(hash, password);
}

/** Policy: 10–128 chars (docs/ARCHITECTURE.md §4 D). Returns an error message, or null. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}
