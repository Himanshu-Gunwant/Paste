import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/** Phase 7 integration suite — analytics reads, embed rendering + CSP, storage accounting. */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: analytics & embeds', () => {
  let owner: TestClient;
  let stranger: TestClient;
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    owner = started.client;
    stranger = new TestClient(started.client.baseUrl);
    closeServer = started.close;

    await owner.json('POST', '/api/v1/auth/register', {
      body: { email: `an-${suffix}@example.test`, username: `anowner-${suffix}`.slice(0, 30), password: PASSWORD },
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

  it('exposes paste stats to the owner only, with daily series', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'stats target', title: 'Stat paste' },
    });
    const id = created.body.paste.id as string;

    const today = new Date();
    await prisma.pasteViewDaily.create({
      data: {
        pasteId: id,
        day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
        views: 7n,
        uniqueVisitors: 5n,
      },
    });
    await prisma.paste.update({ where: { id }, data: { viewCount: 7n } });

    const stats = await owner.json('GET', `/api/v1/pastes/${id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.stats.totals.views).toBe('7');
    expect(stats.body.stats.totals.uniqueVisitors).toBe('5');
    expect(stats.body.stats.daily.length).toBe(1);
    expect(stats.body.stats.daily[0].views).toBe(7);

    const forbidden = await stranger.json('GET', `/api/v1/pastes/${id}/stats`, { sendCookies: false });
    expect(forbidden.status).toBe(401);

    const strangerSession = await stranger.json('POST', '/api/v1/auth/register', {
      body: { email: `ans-${suffix}@example.test`, username: `ans-${suffix}`.slice(0, 30), password: PASSWORD },
    });
    expect(strangerSession.status).toBe(201);
    const denied = await stranger.json('GET', `/api/v1/pastes/${id}/stats`);
    expect(denied.status).toBe(403);
  });

  it('aggregates user analytics across own pastes', async () => {
    const analytics = await owner.json('GET', '/api/v1/users/me/analytics');
    expect(analytics.status).toBe(200);
    expect(Number(analytics.body.totals.views)).toBeGreaterThanOrEqual(7);
    expect(Number(analytics.body.totals.pastes)).toBeGreaterThanOrEqual(1);
    expect(analytics.body.daily.length).toBeGreaterThanOrEqual(1);
  });

  it('maintains the denormalized storage counter through the paste lifecycle', async () => {
    const before = await owner.json('GET', '/api/v1/users/me/analytics');
    const startStorage = Number(before.body.totals.storageUsed);

    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'x'.repeat(500) },
    });
    const afterCreate = await owner.json('GET', '/api/v1/users/me/analytics');
    expect(Number(afterCreate.body.totals.storageUsed)).toBe(startStorage + 500);

    await owner.json('PATCH', `/api/v1/pastes/${created.body.paste.id}`, {
      body: { content: 'y'.repeat(800) },
    });
    const afterUpdate = await owner.json('GET', '/api/v1/users/me/analytics');
    expect(Number(afterUpdate.body.totals.storageUsed)).toBe(startStorage + 800);

    await owner.json('DELETE', `/api/v1/pastes/${created.body.paste.id}`);
    const afterDelete = await owner.json('GET', '/api/v1/users/me/analytics');
    expect(Number(afterDelete.body.totals.storageUsed)).toBe(startStorage);
  });

  it('renders embeds with escaped, highlighted content and strict CSP', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: {
        content: '<script>alert("xss")</script>\nconst greeting = "hi";\n',
        language: 'javascript',
        title: 'Embed & <test>',
      },
      sendCookies: false,
    });
    const id = created.body.paste.id as string;

    const res = await stranger.request('GET', `/embed/${id}`, { sendCookies: false });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert'); // escaped — no executable user HTML
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('greeting');
    expect(html).toContain('Embed &amp; &lt;test&gt;');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors *');
    expect(res.headers.get('x-frame-options')).toBeNull(); // removed for embeds
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    // Config: theme + line range.
    const ranged = await stranger.request('GET', `/embed/${id}?theme=light&range=2-2&lines=off`, {
      sendCookies: false,
    });
    const rangedHtml = await ranged.text();
    expect(rangedHtml).toContain('class="light"');
    expect(rangedHtml).toContain('greeting');
    expect(rangedHtml).not.toContain('&lt;script&gt;'); // line 2 only
  });

  it('denies embeds of private and password-protected pastes; share token unlocks private', async () => {
    const priv = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'private embed', visibility: 'private' },
    });
    const privId = priv.body.paste.id as string;
    const denied = await stranger.request('GET', `/embed/${privId}`, { sendCookies: false });
    expect(denied.status).toBe(404);

    const token = await owner.json('POST', `/api/v1/pastes/${privId}/share-tokens`, {});
    expect(token.status).toBe(201);
    const allowed = await stranger.request(
      'GET',
      `/embed/${privId}?share_token=${token.body.shareToken as string}`,
      { sendCookies: false },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('private embed');

    const locked = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'locked', password: 'embed-pw-1' },
    });
    const lockedDenied = await stranger.request('GET', `/embed/${locked.body.paste.id}`, {
      sendCookies: false,
    });
    expect(lockedDenied.status).toBe(404);

    // Unlisted embeds fine; consumed burn → 404.
    const unlisted = await stranger.json('POST', '/api/v1/pastes', {
      body: { content: 'unlisted embed', visibility: 'unlisted' },
      sendCookies: false,
    });
    const ok = await stranger.request('GET', `/embed/${unlisted.body.paste.id}`, { sendCookies: false });
    expect(ok.status).toBe(200);

    const burn = await stranger.json('POST', '/api/v1/pastes', {
      body: { content: 'burn embed', burnAfterRead: true },
      sendCookies: false,
    });
    await stranger.json('GET', `/api/v1/pastes/${burn.body.paste.id}`, { sendCookies: false });
    const burnedEmbed = await stranger.request('GET', `/embed/${burn.body.paste.id}`, { sendCookies: false });
    expect(burnedEmbed.status).toBe(404);
  });
});
