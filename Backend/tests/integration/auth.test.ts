import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { startEmailWorker } from '../../src/workers/email.worker.js';
import { closeQueues, getQueueConnection } from '../../src/queues/queues.js';
import {
  extractTokenFromLink,
  resetRateLimits,
  TestClient,
  uniqueSuffix,
  waitForEmail,
  wipeMailbox,
} from '../helpers/test-client.js';

/**
 * Phase 1 integration suite — real PostgreSQL + Redis + MailHog.
 * Covers: register/login/logout, verification + reset email flows end-to-end
 * (email worker → SMTP → MailHog → token extraction), session management,
 * CSRF origin guard, profile updates, account deletion, rate limits.
 */
const run = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!run)('integration: auth flows', () => {
  let client: TestClient;
  let closeServer: () => Promise<void>;
  let emailWorker: ReturnType<typeof startEmailWorker>;

  const suffix = uniqueSuffix();
  const password = 'correct-horse-42';
  const email = `alice-${suffix}@example.test`;
  const username = `alice-${suffix}`.slice(0, 30);

  beforeAll(async () => {
    const started = await TestClient.start();
    client = started.client;
    closeServer = started.close;
    await wipeMailbox();
    await resetRateLimits();
    getQueueConnection(); // warm queue connection for the inline email worker
    emailWorker = startEmailWorker();
  });

  beforeEach(async () => {
    // Each test gets a fresh rate-limit budget; the dedicated limiter test
    // resets again itself and runs its own 10-request sequence.
    await resetRateLimits();
  });

  afterAll(async () => {
    await emailWorker.close();
    await closeQueues();
    await closeRedis();
    await closePrisma();
    await closeServer();
  });

  it('registers a user, sets a session cookie, and exposes /users/me', async () => {
    const { status, body, res } = await client.json('POST', '/api/v1/auth/register', {
      body: { email, username, password },
    });
    expect(status).toBe(201);
    expect(body.user.email).toBe(email);
    expect(body.user.username).toBe(username);
    expect(body.user.emailVerified).toBe(false);
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-sess='))).toBe(true);

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(username);
  });

  it('rejects duplicate email and username with distinct 409s', async () => {
    const another = new TestClient(client.baseUrl);
    const dupEmail = await another.json('POST', '/api/v1/auth/register', {
      body: { email, username: `other-${suffix}`.slice(0, 30), password },
    });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.message).toBe('Email is already registered');

    const dupUsername = await another.json('POST', '/api/v1/auth/register', {
      body: { email: `free-${suffix}@example.test`, username, password },
    });
    expect(dupUsername.status).toBe(409);
    expect(dupUsername.body.error.message).toBe('Username is already taken');
  });

  it('verifies email end-to-end via the queued email + MailHog', async () => {
    const text = await waitForEmail(email, 'Verify your email address');
    const token = extractTokenFromLink(text);

    const { status, body } = await client.json('POST', '/api/v1/auth/verify-email/confirm', {
      body: { token },
    });
    expect(status).toBe(200);
    expect(body.emailVerified).toBe(true);

    // Single-use: replaying the token must fail.
    const replay = await client.json('POST', '/api/v1/auth/verify-email/confirm', {
      body: { token },
    });
    expect(replay.status).toBe(400);

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.body.user.emailVerified).toBe(true);
  });

  it('logs in with correct credentials and rejects wrong/unknown uniformly', async () => {
    const wrongPw = await client.json('POST', '/api/v1/auth/login', {
      body: { email, password: 'not-the-password' },
      sendCookies: false,
    });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error.message).toBe('Invalid email or password');

    const unknownEmail = await client.json('POST', '/api/v1/auth/login', {
      body: { email: `ghost-${suffix}@example.test`, password: 'whatever-password' },
      sendCookies: false,
    });
    expect(unknownEmail.status).toBe(401);
    // Identical message + timing-equalized path → no account enumeration.
    expect(unknownEmail.body.error.message).toBe('Invalid email or password');

    client.clearCookies();
    const ok = await client.json('POST', '/api/v1/auth/login', {
      body: { email, password },
    });
    expect(ok.status).toBe(200);
  });

  it('logs out and invalidates the session', async () => {
    const logout = await client.json('POST', '/api/v1/auth/logout');
    expect(logout.status).toBe(204);
    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(401);
  });

  it('resets password end-to-end and revokes all prior sessions', async () => {
    // Fresh login to have a live session that must be invalidated by reset.
    client.clearCookies();
    const login = await client.json('POST', '/api/v1/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);

    const unknown = await client.json('POST', '/api/v1/auth/password-reset/request', {
      body: { email: `nobody-${suffix}@example.test` },
    });
    expect(unknown.status).toBe(202); // uniform response — no enumeration

    const requested = await client.json('POST', '/api/v1/auth/password-reset/request', {
      body: { email },
    });
    expect(requested.status).toBe(202);

    const text = await waitForEmail(email, 'Reset your password');
    const token = extractTokenFromLink(text);
    const newPassword = 'even-correcter-horse-7';

    const confirmed = await client.json('POST', '/api/v1/auth/password-reset/confirm', {
      body: { token, newPassword },
    });
    expect(confirmed.status).toBe(204);

    // All sessions were revoked by the reset.
    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(401);

    client.clearCookies();
    const oldPw = await client.json('POST', '/api/v1/auth/login', { body: { email, password }, sendCookies: false });
    expect(oldPw.status).toBe(401);
    const newPw = await client.json('POST', '/api/v1/auth/login', { body: { email, password: newPassword } });
    expect(newPw.status).toBe(200);
  });

  it('lists, revokes individually, and revokes all sessions', async () => {
    // Client currently holds one session from the reset login.
    const extra = await client.json('POST', '/api/v1/auth/login', { body: { email, password: 'even-correcter-horse-7' } });
    expect(extra.status).toBe(200);

    const list = await client.json('GET', '/api/v1/users/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(2);
    expect(list.body.data[0]).toHaveProperty('id');
    expect(list.body.data[0]).not.toHaveProperty('userId');

    const targetId = list.body.data[1].id as string;
    const revokeOne = await client.json('DELETE', `/api/v1/users/me/sessions/${targetId}`);
    expect(revokeOne.status).toBe(204);

    const afterOne = await client.json('GET', '/api/v1/users/me/sessions');
    expect(afterOne.body.data.length).toBe(1);

    const revokeAll = await client.json('DELETE', '/api/v1/users/me/sessions');
    expect(revokeAll.status).toBe(200);
    expect(revokeAll.body.revoked).toBe(1);

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(401);
  });

  it('updates the profile and exposes a public profile without email', async () => {
    client.clearCookies();
    await client.json('POST', '/api/v1/auth/login', {
      body: { email, password: 'even-correcter-horse-7' },
    });

    const patched = await client.json('PATCH', '/api/v1/users/me', {
      body: { displayName: 'Alice', bio: 'Test user', websiteUrl: 'https://alice.example.test' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user.displayName).toBe('Alice');

    const invalid = await client.json('PATCH', '/api/v1/users/me', {
      body: { websiteUrl: 'not-a-url' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const publicProfile = await client.json('GET', `/api/v1/users/${username}`);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.body.profile.displayName).toBe('Alice');
    expect(publicProfile.body.profile).not.toHaveProperty('email');

    const missing = await client.json('GET', '/api/v1/users/never-exists-xyz');
    expect(missing.status).toBe(404);
  });

  it('rejects cross-origin mutating requests carrying a session cookie', async () => {
    const evil = await client.json('PATCH', '/api/v1/users/me', {
      body: { bio: 'hacked' },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('FORBIDDEN');

    // Allowed origin passes; GET requests are never origin-checked.
    const allowed = await client.json('PATCH', '/api/v1/users/me', {
      body: { bio: 'ok' },
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(200);
  });

  it('deletes the account: PII scrub, session loss, login blocked, email freed', async () => {
    const deleted = await client.json('DELETE', '/api/v1/users/me', {
      body: { password: 'even-correcter-horse-7' },
    });
    expect(deleted.status).toBe(204);

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(401);

    const publicProfile = await client.json('GET', `/api/v1/users/${username}`);
    expect(publicProfile.status).toBe(404);

    const row = await prisma.user.findFirst({ where: { username } });
    expect(row?.status).toBe('DELETED');
    expect(row?.email).toContain('deleted+');
    expect(row?.passwordHash).toBeNull();

    client.clearCookies();
    const loginAfter = await client.json('POST', '/api/v1/auth/login', {
      body: { email, password: 'even-correcter-horse-7' },
      sendCookies: false,
    });
    expect(loginAfter.status).toBe(401);

    // The email address is released (anonymized to deleted+{id}@invalid).
    const reRegister = await client.json('POST', '/api/v1/auth/register', {
      body: { email, username: `re-${suffix}`.slice(0, 30), password },
      sendCookies: false,
    });
    expect(reRegister.status).toBe(201);
  });

  it('enforces the auth rate limit (10 per 15 min per IP) with 429 + Retry-After', async () => {
    await resetRateLimits();
    // 10 distinct-email failures stay under the IP budget...
    for (let i = 0; i < 10; i++) {
      const res = await client.json('POST', '/api/v1/auth/login', {
        body: { email: `burst-${suffix}-${i}@example.test`, password: 'wrong-password' },
        sendCookies: false,
      });
      expect(res.status).toBe(401);
    }
    // ...the 11th hits the limiter.
    const limited = await client.json('POST', '/api/v1/auth/login', {
      body: { email: `burst-${suffix}-11@example.test`, password: 'wrong-password' },
      sendCookies: false,
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.res.headers.get('retry-after')).toBeTruthy();
    expect(limited.res.headers.get('ratelimit-limit')).toBe('10');
  });
});
