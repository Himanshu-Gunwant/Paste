import { describe, expect, it } from 'vitest';
import { hashPassword, passwordPolicyError, verifyPassword } from '../../src/lib/crypto.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword(hash, 'wrong-horse')).toBe(false);
  });

  it('returns false (not throw) when no hash exists, with equal argon2 work', async () => {
    // Dummy-hash timing equalization path — must complete real argon2 work.
    const start = process.hrtime.bigint();
    const result = await verifyPassword(null, 'whatever-input');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(result).toBe(false);
    // Argon2id at OWASP baseline takes well over 10 ms; a missing-user login
    // must not shortcut below it (timing-enumeration guard).
    expect(elapsedMs).toBeGreaterThan(5);
  });
});

describe('passwordPolicyError', () => {
  it('accepts passwords at the 10-char boundary', () => {
    expect(passwordPolicyError('1234567890')).toBeNull();
  });

  it('rejects short passwords', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 10/);
  });

  it('rejects over-long passwords (DoS guard)', () => {
    expect(passwordPolicyError('a'.repeat(129))).toMatch(/at most 128/);
    expect(passwordPolicyError('a'.repeat(128))).toBeNull();
  });
});
