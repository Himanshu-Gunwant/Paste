import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isOAuthProvider, start } from '../../src/services/oauth.service.js';

describe('oauth.service.start', () => {
  it('builds a Google authorize URL with state and PKCE S256', () => {
    const started = start('google');
    const url = new URL(started.authorizeUrl);
    // Endpoints come from env (tests route them to the mock provider server);
    // the unit assertion is that the authorize URL is composed from config.
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:18888/google/auth');
    expect(url.searchParams.get('client_id')).toBe('test-google-client');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe(started.stateCookie.state);
    const challenge = url.searchParams.get('code_challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // S256: challenge = base64url(sha256(verifier))
    const expected = createHash('sha256').update(started.stateCookie.verifier ?? '').digest('base64url');
    expect(challenge).toBe(expected);
    expect(started.stateCookieMaxAgeSeconds).toBeLessThanOrEqual(600);
  });

  it('builds a GitHub authorize URL without PKCE (classic OAuth apps lack it)', () => {
    const started = start('github');
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:18888/github/auth');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBe(started.stateCookie.state);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(started.stateCookie.verifier).toBeUndefined();
  });

  it('generates unique single-use states', () => {
    const states = new Set(Array.from({ length: 50 }, () => start('google').stateCookie.state));
    expect(states.size).toBe(50);
  });
});

describe('isOAuthProvider', () => {
  it('accepts configured providers only', () => {
    expect(isOAuthProvider('google')).toBe(true);
    expect(isOAuthProvider('github')).toBe(true);
    expect(isOAuthProvider('facebook')).toBe(false);
    expect(isOAuthProvider('')).toBe(false);
  });
});
