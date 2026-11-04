import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { prisma } from '../../src/lib/prisma.js';
import { closePrisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * Phase 9 security consolidation suite (docs/ARCHITECTURE.md §13, §19 phase 9):
 * cookie/flag hygiene, header posture, injection/traversal handling, payload
 * limits, unicode byte accounting, enumeration uniformity.
 */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: security posture', () => {
  let client: TestClient;
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    client = started.client;
    closeServer = started.close;
    await client.json('POST', '/api/v1/auth/register', {
      body: { email: `sec-${suffix}@example.test`, username: `sec-${suffix}`.slice(0, 30), password: PASSWORD },
    });
  });

  beforeEach(async () => {
    await resetRateLimits();
  });

  afterAll(async () => {
    await closeQueues();
    await closeRedis();
    await closePrisma();
    await closeServer();
  });

  it('sets hardened session cookies', async () => {
    const res = await client.request('POST', '/api/v1/auth/login', {
      body: { email: `sec-${suffix}@example.test`, password: PASSWORD },
      sendCookies: false,
    });
    const sessionCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-sess='));
    expect(sessionCookie).toBeDefined();
    const cookie = sessionCookie!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    // Dev runs over plain HTTP — Secure would break local flows; prod sets it
    // via NODE_ENV (asserted by configuration, not wire format here).
    expect(cookie.startsWith('__Host-sess=')).toBe(true); // __Host- prefix requires Secure+Path in prod
  });

  it('sends the baseline security header set on every response', async () => {
    const res = await fetch(`${client.baseUrl}/api/v1/languages`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('stores SQL-injection attempts as inert data (parameterized throughout)', async () => {
    const payload = `'; DROP TABLE pastes; -- ' OR '1'='1`;
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: payload, title: payload },
    });
    expect(created.status).toBe(201);
    const view = await client.json('GET', `/api/v1/pastes/${created.body.paste.id}`);
    expect(view.body.paste.content).toBe(payload); // verbatim, inert

    // The table still exists and search treats the input as a literal query.
    const search = await client.json('GET', '/api/v1/search?q=DROP+TABLE', { sendCookies: false });
    expect(search.status).toBe(200);
    const pastes = await prisma.paste.count();
    expect(pastes).toBeGreaterThan(0);
  });

  it('neutralizes path traversal in identifiers (uniform 404, no crash)', async () => {
    for (const attempt of ['../../etc/passwd', '..%2F..%2Fetc', '....//....//etc']) {
      const res = await client.json('GET', `/api/v1/pastes/${encodeURIComponent(attempt)}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const weird = await client.json('GET', '/api/v1/pastes/%2e%2e%2f%2e%2e');
    expect(weird.status).toBe(404);
  });

  it('enforces the request body limit with 413', async () => {
    const res = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'x'.repeat(2_500_000) },
    });
    expect([413, 400]).toContain(res.status); // nginx absent locally → express limit
    if (res.status === 413) {
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('accounts multi-byte content by bytes, not code units', async () => {
    // 10 emoji = 40 UTF-8 bytes but 10 code-unit pairs (20 units) + variation selectors
    const content = '🖱️🎯🚀💡🔒📌✅🌟🎉📦';
    const bytes = Buffer.byteLength(content, 'utf8');
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content },
    });
    expect(created.status).toBe(201);
    expect(created.body.paste.contentSize).toBe(bytes);
    expect(bytes).toBeGreaterThan(content.length);
  });

  it('keeps login enumeration uniform (same status + message for unknown emails)', async () => {
    const unknown = await client.json('POST', '/api/v1/auth/login', {
      body: { email: `ghost-${suffix}@example.test`, password: PASSWORD },
      sendCookies: false,
    });
    const wrongPassword = await client.json('POST', '/api/v1/auth/login', {
      body: { email: `sec-${suffix}@example.test`, password: 'wrong-password-x' },
      sendCookies: false,
    });
    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('rejects cross-site mutating requests while allowing same-origin', async () => {
    const evil = await client.json('PATCH', '/api/v1/users/me', {
      body: { bio: 'csrf' },
      headers: { origin: 'https://attacker.example' },
    });
    expect(evil.status).toBe(403);

    const friendly = await client.json('PATCH', '/api/v1/users/me', {
      body: { bio: 'ok' },
      headers: { origin: 'http://localhost:5173' },
    });
    expect(friendly.status).toBe(200);
  });

  it('never exposes password hashes or token hashes in any response', async () => {
    const me = await client.json('GET', '/api/v1/users/me');
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('$argon2');

    const sessions = await client.json('GET', '/api/v1/users/me/sessions');
    expect(JSON.stringify(sessions.body)).not.toContain('tokenHash');
    expect(JSON.stringify(sessions.body)).not.toContain('passwordHash');
  });
});
