import { describe, expect, it } from 'vitest';
import { generatePasteId, generateToken, hashToken, verifyToken } from '../../src/lib/tokens.js';

describe('generateToken', () => {
  it('produces 32-byte base64url tokens by default (43 chars)', () => {
    const token = generateToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique tokens', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(seen.size).toBe(1000);
  });
});

describe('hashToken / verifyToken', () => {
  it('hashes deterministically to 64 hex chars', () => {
    const hash = hashToken('a-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('a-token')).toBe(hash);
  });

  it('verifies the correct candidate', () => {
    const token = generateToken();
    expect(verifyToken(token, hashToken(token))).toBe(true);
  });

  it('rejects wrong candidates', () => {
    const hash = hashToken('correct');
    expect(verifyToken('wrong', hash)).toBe(false);
    expect(verifyToken('correct ', hash)).toBe(false);
    expect(verifyToken('', hash)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyToken('anything', 'not-a-hash')).toBe(false);
    expect(verifyToken('anything', '')).toBe(false);
  });
});

describe('generatePasteId', () => {
  const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

  it('produces 10-character ids from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const id = generatePasteId();
      expect(id).toHaveLength(10);
      expect([...id].every((ch) => ALPHABET.includes(ch))).toBe(true);
    }
  });

  it('never produces ambiguous characters (0, O, 1, l, I)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePasteId()).not.toMatch(/[0O1lI]/);
    }
  });

  it('produces unique ids at a meaningful sample size', () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => generatePasteId()));
    expect(seen.size).toBe(10_000);
  });
});
