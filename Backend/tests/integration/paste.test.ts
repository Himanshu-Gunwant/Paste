import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS_KEYS, ANON_DAILY_PASTE_QUOTA, utcDateKey } from '../../src/config/constants.js';
import { closeRedis, getRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { flushViewDeltas } from '../../src/services/view.service.js';
import { sweepExpiredPastes, sweepPurgeTombstones } from '../../src/workers/maintenance.worker.js';
import { processExpireJob } from '../../src/workers/paste-jobs.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * Phase 2 integration suite — the phase gate: burn concurrency (exactly one
 * consumer), flush crash recovery (exactly-once), expiry race (read-path
 * filter before any worker), the paste authorization matrix, management
 * tokens, max_views, quotas and fork semantics.
 */
const run = process.env.RUN_INTEGRATION === '1';

const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: paste core', () => {
  let client: TestClient;
  let other: TestClient;
  let closeServer: () => Promise<void>;

  const suffix = uniqueSuffix();
  let ownerEmail: string;
  let ownerId = '';
  let adminId = '';

  beforeAll(async () => {
    // Suites share Redis state (the auth limiter is IP-keyed) — start clean.
    await resetRateLimits();
    const started = await TestClient.start();
    client = started.client;
    other = new TestClient(started.client.baseUrl);
    closeServer = started.close;

    // Owner + stranger accounts; admin via direct role assignment.
    ownerEmail = `owner-${suffix}@example.test`;
    const ownerReg = await client.json('POST', '/api/v1/auth/register', {
      body: { email: ownerEmail, username: `owner-${suffix}`.slice(0, 30), password: PASSWORD },
    });
    ownerId = ownerReg.body.user.id;
    const strangerReg = await other.json('POST', '/api/v1/auth/register', {
      body: { email: `stranger-${suffix}@example.test`, username: `stranger-${suffix}`.slice(0, 30), password: PASSWORD },
    });
    const adminReg = await prisma.user.create({
      data: {
        email: `admin-${suffix}@example.test`,
        username: `admin-${suffix}`.slice(0, 30),
        passwordHash: null,
        role: 'ADMIN',
      },
    });
    adminId = adminReg.id;
    void strangerReg;
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

  it('creates an anonymous paste with a one-time management token', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'console.log("hello paste");', language: 'javascript', title: 'Hello' },
      sendCookies: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.paste.id).toHaveLength(10);
    expect(created.body.paste.detectedLanguage).toBe('javascript');
    expect(created.body.managementToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const view = await client.json('GET', `/api/v1/pastes/${created.body.paste.id}`, { sendCookies: false });
    expect(view.status).toBe(200);
    expect(view.body.paste.content).toBe('console.log("hello paste");');
    expect(view.body.paste.author).toBeNull();
    expect(view.body.paste).not.toHaveProperty('viewCount'); // strangers see no stats
  });

  it('supports custom slugs and rejects duplicates (global namespace)', async () => {
    const slug = `my-slug-${suffix}`;
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'slugged', customSlug: slug },
      sendCookies: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.paste.id).toBe(slug);

    const viaSlug = await client.json('GET', `/api/v1/pastes/${slug}`, { sendCookies: false });
    expect(viaSlug.status).toBe(200);

    const dup = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'again', customSlug: slug },
      sendCookies: false,
    });
    expect(dup.status).toBe(409);

    const reserved = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'x', customSlug: 'admin' },
      sendCookies: false,
    });
    expect(reserved.status).toBe(400);
  });

  it('enforces the visibility matrix (private 404 for strangers, admin bypass)', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'private secret', visibility: 'private' },
    });
    const id = created.body.paste.id as string;

    const anon = await client.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(anon.status).toBe(404);
    expect(anon.body.error.code).toBe('NOT_FOUND');

    const stranger = await other.json('GET', `/api/v1/pastes/${id}`);
    expect(stranger.status).toBe(404);

    const owner = await client.json('GET', `/api/v1/pastes/${id}`);
    expect(owner.status).toBe(200);
    expect(owner.body.paste.content).toBe('private secret');
    expect(owner.body.paste.viewCount).toBe(0); // owner sees stats

    const adminClient = new TestClient(client.baseUrl);
    // Admin has no password → sign-in impossible; mint a session row directly.
    const { createSession } = await import('../../src/services/session.service.js');
    const { token } = await createSession({ userId: adminId, ip: null, userAgent: 'vitest' });
    adminClient.setCookie('__Host-sess', token);
    const admin = await adminClient.json('GET', `/api/v1/pastes/${id}`);
    expect(admin.status).toBe(200);
  });

  it('keeps unlisted pastes accessible by link but invisible to authorization tricks', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'unlisted note', visibility: 'unlisted' },
    });
    const view = await client.json('GET', `/api/v1/pastes/${created.body.paste.id}`, { sendCookies: false });
    expect(view.status).toBe(200);
    expect(view.body.paste.visibility).toBe('unlisted');
  });

  it('gates password-protected pastes and lets the owner bypass', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'locked content', password: 'paste-pw-1', visibility: 'public' },
    });
    const id = created.body.paste.id as string;

    const anon = await client.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('PASSWORD_REQUIRED');
    expect(anon.body.paste).toBeUndefined();

    const wrong = await client.json('POST', `/api/v1/pastes/${id}/unlock`, {
      body: { password: 'wrong-password' },
      sendCookies: false,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PASSWORD');

    const right = await client.json('POST', `/api/v1/pastes/${id}/unlock`, {
      body: { password: 'paste-pw-1' },
      sendCookies: false,
    });
    expect(right.status).toBe(200);
    expect(right.body.paste.content).toBe('locked content');

    const owner = await client.json('GET', `/api/v1/pastes/${id}`);
    expect(owner.status).toBe(200);
    expect(owner.body.paste.content).toBe('locked content'); // owner bypasses the gate
  });

  it('lets the management token update and delete an anonymous paste (then dies)', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'anon owned', visibility: 'unlisted' },
      sendCookies: false,
    });
    const id = created.body.paste.id as string;
    const token = created.body.managementToken as string;

    const wrong = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { title: 'hijacked' },
      headers: { 'x-management-token': 'not-the-token' },
      sendCookies: false,
    });
    expect(wrong.status).toBe(404);

    const patched = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { title: 'renamed by token' },
      headers: { 'x-management-token': token },
      sendCookies: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.paste.title).toBe('renamed by token');

    const removed = await client.json('DELETE', `/api/v1/pastes/${id}`, {
      headers: { 'x-management-token': token },
      sendCookies: false,
    });
    expect(removed.status).toBe(204);

    const gone = await client.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(gone.status).toBe(404);

    const tokenDead = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { title: 'x' },
      headers: { 'x-management-token': token },
      sendCookies: false,
    });
    expect(tokenDead.status).toBe(404);
  });

  it('enforces max_views exactly (strangers 404, owner 410)', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'limited', maxViews: 2 },
    });
    const id = created.body.paste.id as string;

    const strangerClient = new TestClient(client.baseUrl);
    const first = await strangerClient.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(first.status).toBe(200);
    const second = await strangerClient.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(second.status).toBe(200);
    const third = await strangerClient.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(third.status).toBe(404);

    const owner = await client.json('GET', `/api/v1/pastes/${id}`);
    expect(owner.status).toBe(410);
    expect(owner.body.error.code).toBe('GONE');
  });

  it('consumes a burn-after-read paste exactly once under concurrency', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'read me once', burnAfterRead: true },
      sendCookies: false,
    });
    const id = created.body.paste.id as string;

    const c1 = new TestClient(client.baseUrl);
    const c2 = new TestClient(client.baseUrl);
    const [r1, r2] = await Promise.all([
      c1.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false }),
      c2.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 404]);
    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.body.paste.content).toBe('read me once');

    const row = await prisma.paste.findUnique({ where: { id } });
    expect(row?.content).toBeNull(); // nulled inside the claim transaction
    expect(row?.burnedAt).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();

    const after = await client.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(after.status).toBe(404);
  });

  it('never consumes a burn paste on failed password attempts', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'burn but locked', burnAfterRead: true, password: 'burn-pw-9' },
    });
    const id = created.body.paste.id as string;

    const stranger = new TestClient(client.baseUrl);
    for (let i = 0; i < 3; i++) {
      const wrong = await stranger.json('POST', `/api/v1/pastes/${id}/unlock`, {
        body: { password: `wrong-${i}` },
        sendCookies: false,
      });
      expect(wrong.status).toBe(401);
    }
    expect((await prisma.paste.findUnique({ where: { id } }))?.content).toBe('burn but locked');

    const right = await stranger.json('POST', `/api/v1/pastes/${id}/unlock`, {
      body: { password: 'burn-pw-9' },
      sendCookies: false,
    });
    expect(right.status).toBe(200);

    const again = await stranger.json('POST', `/api/v1/pastes/${id}/unlock`, {
      body: { password: 'burn-pw-9' },
      sendCookies: false,
    });
    expect(again.status).toBe(404); // consumed — uniform for strangers
  });

  it('blocks expired pastes at the read path BEFORE any worker runs', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'ephemeral', expiresIn: '10min' },
      sendCookies: false,
    });
    const id = created.body.paste.id as string;

    // Backdate expiry directly — no worker involved yet.
    await prisma.paste.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const anon = await client.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false });
    expect(anon.status).toBe(404); // query-side filter, worker-lag-proof

    const swept = await sweepExpiredPastes();
    expect(swept).toContain(id);
    const row = await prisma.paste.findUnique({ where: { id } });
    expect(row?.content).toBeNull();
    expect(row?.deletedBy).toBe('SYSTEM');

    // Expire job re-run is a no-op (idempotent).
    await processExpireJob({ data: { pasteId: id } } as never);
    expect((await prisma.paste.findUnique({ where: { id } }))?.content).toBeNull();
  });

  it('purges tombstones after retention and keeps fresh ones', async () => {
    const fresh = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'fresh tombstone' },
      sendCookies: false,
    });
    await prisma.paste.update({
      where: { id: fresh.body.paste.id },
      data: { content: null, deletedAt: new Date(), deletedBy: 'SYSTEM' },
    });

    const old = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'old tombstone' },
      sendCookies: false,
    });
    await prisma.paste.update({
      where: { id: old.body.paste.id },
      data: { content: null, deletedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), deletedBy: 'SYSTEM' },
    });

    await sweepPurgeTombstones();
    expect(await prisma.paste.findUnique({ where: { id: old.body.paste.id } })).toBeNull();
    expect(await prisma.paste.findUnique({ where: { id: fresh.body.paste.id } })).not.toBeNull();
  });

  it('flushes buffered views exactly-once with crash recovery', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'count me' },
      sendCookies: false,
    });
    const id = created.body.paste.id as string;
    const redis = getRedis();

    await redis.incr(REDIS_KEYS.viewDelta(id));
    await redis.incr(REDIS_KEYS.viewDelta(id));
    await redis.incr(REDIS_KEYS.viewDelta(id));

    const first = await flushViewDeltas('run-1');
    expect(first.applied).toBeGreaterThanOrEqual(1);
    const row = await prisma.paste.findUnique({ where: { id } });
    expect(Number(row?.viewCount)).toBe(3);

    // Re-flush with the same deltas gone → no double counting.
    await flushViewDeltas('run-2');
    expect(Number((await prisma.paste.findUnique({ where: { id } }))?.viewCount)).toBe(3);

    // Simulate a crashed flush: claimed delta left in an inflight key.
    await redis.incr(REDIS_KEYS.viewDelta(id));
    await redis.incr(REDIS_KEYS.viewDelta(id));
    await redis.rename(REDIS_KEYS.viewDelta(id), REDIS_KEYS.viewInflight(id, 'crashed'));

    const recovery = await flushViewDeltas('run-3');
    expect(recovery.recovered).toBe(1);
    expect(Number((await prisma.paste.findUnique({ where: { id } }))?.viewCount)).toBe(5);
    expect(await redis.get(REDIS_KEYS.viewInflight(id, 'crashed'))).toBeNull();

    // Concurrent flushes cannot double-claim.
    await redis.incr(REDIS_KEYS.viewDelta(id));
    await Promise.all([flushViewDeltas('a'), flushViewDeltas('b'), flushViewDeltas('c')]);
    expect(Number((await prisma.paste.findUnique({ where: { id } }))?.viewCount)).toBe(6);

    // Daily aggregate row exists with the same total.
    const daily = await prisma.pasteViewDaily.findFirst({ where: { pasteId: id } });
    expect(Number(daily?.views)).toBe(6);
  });

  it('enforces the anonymous daily creation quota', async () => {
    const ip = '203.0.113.99';
    await getRedis().set(REDIS_KEYS.anonQuota(ip, utcDateKey()), String(ANON_DAILY_PASTE_QUOTA), 'EX', 3600);
    // Requests from that exact IP: spoofed via X-Forwarded-For? trust proxy = 1
    // only honors the immediate hop, so simulate at the socket level instead:
    // use the default test IP but inject the quota key for IT.
    const testIpKey = REDIS_KEYS.anonQuota('::ffff:127.0.0.1', utcDateKey());
    await getRedis().set(testIpKey, String(ANON_DAILY_PASTE_QUOTA), 'EX', 3600);
    void ip;

    const blocked = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'over quota' },
      sendCookies: false,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('forks public pastes with fresh identity and fork attribution', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'forkable content', language: 'python', title: 'Original' },
    });
    const sourceId = created.body.paste.id as string;

    const forked = await other.json('POST', `/api/v1/pastes/${sourceId}/fork`);
    expect(forked.status).toBe(201);
    expect(forked.body.paste.id).not.toBe(sourceId);
    expect(forked.body.paste.forkOfId).toBe(sourceId);
    expect(forked.body.paste.visibility).toBe('public');

    const source = await prisma.paste.findUnique({ where: { id: sourceId } });
    expect(source?.content).toBe('forkable content'); // untouched

    const privatePaste = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'private source', visibility: 'private' },
    });
    const denied = await other.json('POST', `/api/v1/pastes/${privatePaste.body.paste.id}/fork`);
    expect(denied.status).toBe(404);
  });

  it('serves raw text and attachment downloads with correct headers', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'raw body', language: 'typescript', title: 'Raw Test' },
    });
    const id = created.body.paste.id as string;

    const raw = await client.request('GET', `/api/v1/pastes/${id}/raw`, { sendCookies: false });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toContain('text/plain');
    expect(await raw.text()).toBe('raw body');

    const download = await client.request('GET', `/api/v1/pastes/${id}/download`, { sendCookies: false });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-disposition')).toContain('.ts');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('versions content updates with revisions and drops the oldest past the cap', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'version one' },
    });
    const id = created.body.paste.id as string;

    const metadataOnly = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { title: 'renamed, no revision' },
    });
    expect(metadataOnly.status).toBe(200);
    expect((await prisma.paste.findUnique({ where: { id } }))?.latestRevisionNo).toBe(1);

    const v2 = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { content: 'version two' },
    });
    expect(v2.status).toBe(200);
    expect((await prisma.paste.findUnique({ where: { id } }))?.latestRevisionNo).toBe(2);

    // Push past the 20-revision cap: seed a full revision history first.
    await prisma.pasteRevision.createMany({
      data: Array.from({ length: 18 }, (_, i) => ({
        pasteId: id,
        revisionNo: i + 3, // rev 1 (initial) and rev 2 already exist
        content: `version ${i + 3}`,
        contentSize: 10,
      })),
    });
    await prisma.paste.update({ where: { id }, data: { latestRevisionNo: 20 } });

    const v21 = await client.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { content: 'version twenty-one' },
    });
    expect(v21.status).toBe(200);
    const revisions = await prisma.pasteRevision.findMany({ where: { pasteId: id } });
    expect(revisions.length).toBe(20); // cap holds
    expect(revisions.some((r) => r.revisionNo === 1)).toBe(false); // oldest dropped
    expect(revisions.some((r) => r.revisionNo === 2)).toBe(true);
    expect(revisions.some((r) => r.revisionNo === 21)).toBe(true);
  });

  it('rejects cross-user paste management with the uniform 404', async () => {
    const created = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'mine only', visibility: 'unlisted' },
    });
    const id = created.body.paste.id as string;

    const strangerPatch = await other.json('PATCH', `/api/v1/pastes/${id}`, {
      body: { title: 'hijack attempt' },
    });
    expect(strangerPatch.status).toBe(404);

    const strangerDelete = await other.json('DELETE', `/api/v1/pastes/${id}`);
    expect(strangerDelete.status).toBe(404);

    // Payload too large (byte-exact cap).
    const tooBig = await client.json('POST', '/api/v1/pastes', {
      body: { content: 'x'.repeat(1_100_000) },
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    void ownerId;
  });
});
