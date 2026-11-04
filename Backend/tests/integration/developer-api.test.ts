import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_DAILY_QUOTA, utcDateKey } from '../../src/config/constants.js';
import { closeRedis, getRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { flushApiUsage } from '../../src/services/api-usage.service.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * Phase 5 integration suite — developer API: key lifecycle, bearer auth,
 * daily quotas, usage capture, idempotency keys, OpenAPI document.
 */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: developer API', () => {
  let dashboard: TestClient; // session client
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();
  let rawKey = '';
  let keyId = '';
  let userId = '';

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    dashboard = started.client;
    closeServer = started.close;

    const reg = await dashboard.json('POST', '/api/v1/auth/register', {
      body: { email: `api-${suffix}@example.test`, username: `apiuser-${suffix}`.slice(0, 30), password: PASSWORD },
    });
    expect(reg.status).toBe(201);
    userId = reg.body.user.id;
    // Key resolution requires a verified email (§4 H gate) — mark it here;
    // the unverified gate itself is covered by a dedicated test below.
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  });

  beforeEach(async () => {
    await resetRateLimits();
  });

  afterAll(async () => {
    await flushApiUsage();
    await closeQueues();
    await closeRedis();
    await closePrisma();
    await closeServer();
  });

  it('creates a key (shown once), lists prefix-only, and authenticates via bearer', async () => {
    const created = await dashboard.json('POST', '/api/v1/api-keys', {
      body: { name: 'CI key' },
    });
    expect(created.status).toBe(201);
    rawKey = created.body.apiKey.apiKey;
    keyId = created.body.apiKey.id;
    expect(rawKey).toMatch(/^pb_[A-Za-z0-9_-]{43}$/);
    expect(created.body.apiKey.prefix).toBe(rawKey.slice(0, 12));

    const list = await dashboard.json('GET', '/api/v1/api-keys');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);
    expect(list.body.data[0].apiKey).toBeUndefined(); // raw key never re-shown
    expect(JSON.stringify(list.body)).not.toContain(rawKey);
    expect(JSON.stringify(list.body)).not.toContain(keyId === '' ? 'zz' : rawKey.slice(12));

    // Bearer auth on a programmatic endpoint.
    const bearer = new TestClient(dashboard.baseUrl);
    const me = await bearer.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer ${rawKey}` },
      sendCookies: false,
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string } };
    expect(body.user.id).toBe(userId);
  });

  it('rejects unknown and revoked keys uniformly with 401', async () => {
    const unknown = await dashboard.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer pb_${'A'.repeat(43)}` },
      sendCookies: false,
    });
    expect(unknown.status).toBe(401);

    const revoked = await dashboard.json('DELETE', `/api/v1/api-keys/${keyId}`);
    expect(revoked.status).toBe(204);

    const after = await dashboard.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer ${rawKey}` },
      sendCookies: false,
    });
    expect(after.status).toBe(401);
  });

  it('blocks API key management via a key (no amplification)', async () => {
    const created = await dashboard.json('POST', '/api/v1/api-keys', { body: { name: 'second' } });
    expect(created.status).toBe(201);
    const secondRaw = created.body.apiKey.apiKey as string;

    const selfManaged = await dashboard.json('GET', '/api/v1/api-keys', {
      headers: { authorization: `Bearer ${secondRaw}` },
      sendCookies: false,
    });
    expect(selfManaged.status).toBe(403);
    expect(selfManaged.body.error.message).toContain('dashboard');
  });

  it('enforces the daily per-key quota with 429 QUOTA_EXCEEDED', async () => {
    const created = await dashboard.json('POST', '/api/v1/api-keys', { body: { name: 'quota' } });
    const quotaRaw = created.body.apiKey.apiKey as string;
    const quotaId = created.body.apiKey.id as string;

    await getRedis().set(`apiq:${quotaId}:${utcDateKey()}`, String(API_DAILY_QUOTA), 'EX', 3600);

    const limited = await dashboard.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer ${quotaRaw}` },
      sendCookies: false,
    });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('captures usage per request and summarizes it', async () => {
    const created = await dashboard.json('POST', '/api/v1/api-keys', { body: { name: 'usage' } });
    const usageRaw = created.body.apiKey.apiKey as string;

    await dashboard.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer ${usageRaw}` },
      sendCookies: false,
    });
    await dashboard.request('GET', '/api/v1/pastes?limit=1', {
      headers: { authorization: `Bearer ${usageRaw}` },
      sendCookies: false,
    });

    const flushed = await flushApiUsage();
    expect(flushed).toBeGreaterThanOrEqual(2);

    const summary = await dashboard.json('GET', '/api/v1/users/me/api-usage');
    expect(summary.status).toBe(200);
    expect(summary.body.data.length).toBeGreaterThanOrEqual(1);
    expect(summary.body.quota.dailyLimit).toBe(API_DAILY_QUOTA);
  });

  it('replays identical paste-creation retries via Idempotency-Key', async () => {
    const payload = { content: 'idempotent paste', visibility: 'unlisted' };
    const headers = { 'idempotency-key': `test-key-${suffix}-1` };

    const first = await dashboard.json('POST', '/api/v1/pastes', { body: payload, headers });
    expect(first.status).toBe(201);
    expect(first.res.headers.get('idempotency-replayed')).toBe('false');

    const retry = await dashboard.json('POST', '/api/v1/pastes', { body: payload, headers });
    expect(retry.status).toBe(201);
    expect(retry.res.headers.get('idempotency-replayed')).toBe('true');
    expect(retry.body.paste.id).toBe(first.body.paste.id); // NO duplicate resource

    const different = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: 'different body' },
      headers,
    });
    expect(different.status).toBe(422);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Failures are never cached → the same key may be retried.
    const bad = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: '' },
      headers: { 'idempotency-key': `test-key-${suffix}-2` },
    });
    expect(bad.status).toBe(400);
    const recovered = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: 'after failure' },
      headers: { 'idempotency-key': `test-key-${suffix}-2` },
    });
    expect(recovered.status).toBe(201);
  });

  it('returns 409 when the same key is already in flight', async () => {
    // Hold the lock directly (deterministic in-flight simulation).
    await getRedis().set(
      `idem:sess:${userId}:inflight-test-key:lock`,
      '1',
      'EX',
      30,
      'NX',
    );
    const res = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: 'while locked' },
      headers: { 'idempotency-key': 'inflight-test-key' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_IN_FLIGHT');
  });

  it('ignores idempotency keys for anonymous creation', async () => {
    const headers = { 'idempotency-key': `anon-key-${suffix}` };
    const first = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: 'anon one' },
      headers,
      sendCookies: false,
    });
    const second = await dashboard.json('POST', '/api/v1/pastes', {
      body: { content: 'anon two' },
      headers,
      sendCookies: false,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.paste.id).not.toBe(first.body.paste.id);
  });

  it('rejects keys of unverified-email owners', async () => {
    const unverified = await prisma.user.create({
      data: {
        email: `unverified-key-${suffix}@example.test`,
        username: `unvkey-${suffix}`.slice(0, 30),
        passwordHash: null,
        emailVerified: false,
      },
    });
    const raw = `pb_test_unverified_key_placeholder_${suffix}`;
    const { hashToken } = await import('../../src/lib/tokens.js');
    await prisma.apiKey.create({
      data: { userId: unverified.id, name: 'gate', prefix: raw.slice(0, 12), keyHash: hashToken(raw) },
    });
    const res = await dashboard.request('GET', '/api/v1/users/me', {
      headers: { authorization: `Bearer ${raw}` },
      sendCookies: false,
    });
    expect(res.status).toBe(401);
  });

  it('serves a valid OpenAPI document and Swagger UI', async () => {
    const spec = await dashboard.json('GET', '/api/openapi.json', { sendCookies: false });
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThanOrEqual(25);
    expect(spec.body.components.schemas.CreatePasteInput).toBeDefined();

    const ui = await dashboard.request('GET', '/api/docs/', { sendCookies: false });
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
  });
});
