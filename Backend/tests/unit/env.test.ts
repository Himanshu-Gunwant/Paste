import { describe, expect, it } from 'vitest';
import { buildEnv } from '../../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('buildEnv', () => {
  it('accepts minimal config and applies defaults', () => {
    const env = buildEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.FRONTEND_ORIGIN).toBeUndefined();
  });

  it('rejects a missing DATABASE_URL with a legible message', () => {
    expect(() => buildEnv({ REDIS_URL: 'redis://localhost:6379' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing REDIS_URL', () => {
    expect(() => buildEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/REDIS_URL/);
  });

  it('coerces numeric strings for PORT and TRUST_PROXY', () => {
    const env = buildEnv({ ...valid, PORT: '8080', TRUST_PROXY: '2' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(2);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => buildEnv({ ...valid, PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => buildEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => buildEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a malformed FRONTEND_ORIGIN', () => {
    expect(() => buildEnv({ ...valid, FRONTEND_ORIGIN: 'not-a-url' })).toThrow(/FRONTEND_ORIGIN/);
  });

  it('accepts a valid FRONTEND_ORIGIN', () => {
    const env = buildEnv({ ...valid, FRONTEND_ORIGIN: 'https://paste.example.com' });
    expect(env.FRONTEND_ORIGIN).toBe('https://paste.example.com');
  });
});
