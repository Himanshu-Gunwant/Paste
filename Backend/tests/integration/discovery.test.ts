import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis, getRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { recomputeTrending } from '../../src/services/discovery.service.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * Phase 4 integration suite — the LEAK GATE: unlisted/private/expired and
 * suspended-author content can never appear in any discovery endpoint.
 */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: discovery', () => {
  let a: TestClient; // author A
  let b: TestClient; // author B
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();
  let userA = '';
  let userB = '';
  let suspendedUsername = '';

  const publicIds: string[] = [];
  const secretIds: string[] = [];

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    a = started.client;
    b = new TestClient(started.client.baseUrl);
    closeServer = started.close;

    userA = `disc-a-${suffix}`.slice(0, 30);
    userB = `disc-b-${suffix}`.slice(0, 30);
    await a.json('POST', '/api/v1/auth/register', {
      body: { email: `disc-a-${suffix}@example.test`, username: userA, password: PASSWORD },
    });
    await b.json('POST', '/api/v1/auth/register', {
      body: { email: `disc-b-${suffix}@example.test`, username: userB, password: PASSWORD },
    });

    // Content mix: 6 public (3 per author), 2 unlisted, 2 private.
    for (let i = 0; i < 3; i++) {
      const pa = await a.json('POST', '/api/v1/pastes', {
        body: { content: `public A${i}`, title: `Alpha paste ${i}`, language: 'python' },
      });
      publicIds.push(pa.body.paste.id);
      const pb = await b.json('POST', '/api/v1/pastes', {
        body: { content: `public B${i}`, title: `Beta paste ${i}`, language: 'javascript' },
      });
      publicIds.push(pb.body.paste.id);
    }
    for (let i = 0; i < 2; i++) {
      const unlisted = await a.json('POST', '/api/v1/pastes', {
        body: { content: `unlisted secret ${i}`, title: `Unlisted ${i}`, visibility: 'unlisted' },
      });
      secretIds.push(unlisted.body.paste.id);
      const priv = await b.json('POST', '/api/v1/pastes', {
        body: { content: `private secret ${i}`, title: `Private ${i}`, visibility: 'private' },
      });
      secretIds.push(priv.body.paste.id);
    }

    // One suspended author with public content.
    suspendedUsername = `disc-sus-${suffix}`.slice(0, 30);
    await prisma.user.create({
      data: {
        email: `disc-sus-${suffix}@example.test`,
        username: suspendedUsername,
        passwordHash: null,
        status: 'SUSPENDED',
      },
    });
    const suspendedUser = await prisma.user.findUnique({ where: { username: suspendedUsername } });
    await prisma.paste.create({
      data: {
        id: `sus${uniqueSuffix()}`.slice(0, 12).replace(/[^a-zA-Z0-9]/g, 'x'),
        authorId: suspendedUser!.id,
        content: 'suspended content',
        contentSize: 17,
        contentHash: 'x'.repeat(64),
        visibility: 'PUBLIC',
      },
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

  it('latest feed contains ONLY public, live, active-author content', async () => {
    const feed = await a.json('GET', '/api/v1/pastes?sort=latest&limit=50', { sendCookies: false });
    expect(feed.status).toBe(200);
    const ids = feed.body.data.map((s: { id: string }) => s.id);

    for (const id of publicIds) expect(ids).toContain(id);
    for (const id of secretIds) {
      expect(ids).not.toContain(id);
      const row = await prisma.paste.findUnique({ where: { id } });
      expect(row?.visibility).not.toBe('PUBLIC'); // sanity: they exist but are hidden
    }
    expect(ids).not.toContain('suspended');
    const usernames = feed.body.data.map((s: { authorUsername: string | null }) => s.authorUsername);
    expect(usernames).not.toContain(suspendedUsername);
  });

  it('paginates the latest feed with a keyset cursor (no dupes, terminates)', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = `/api/v1/pastes?sort=latest&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await a.json('GET', url, { sendCookies: false });
      expect(page.status).toBe(200);
      for (const item of page.body.data as { id: string }[]) {
        expect(seen).not.toContain(item.id);
        seen.push(item.id);
      }
      pages += 1;
      if (!page.body.pagination?.hasMore) break;
      cursor = page.body.pagination.cursor;
      expect(pages).toBeLessThan(200); // DB persists across suite runs
    }
    expect(pages).toBeGreaterThan(1);
  });

  it('filters by language and author', async () => {
    const py = await a.json('GET', '/api/v1/pastes?language=python&limit=50', { sendCookies: false });
    expect(py.body.data.every((s: { language: string | null }) => s.language === 'python')).toBe(true);

    const byA = await a.json('GET', `/api/v1/pastes?username=${userA}&limit=50`, { sendCookies: false });
    expect(byA.body.data.length).toBe(3);
    expect(byA.body.data.every((s: { authorUsername: string | null }) => s.authorUsername === userA)).toBe(true);
  });

  it('orders the popular feed by view counts', async () => {
    // Seed view counts directly (buffered counters belong to the flush job).
    // Epoch-based values dominate any prior run's seeds in the persistent DB.
    const base = Date.now();
    await prisma.paste.update({ where: { id: publicIds[0]! }, data: { viewCount: BigInt(base + 3) } });
    await prisma.paste.update({ where: { id: publicIds[1]! }, data: { viewCount: BigInt(base + 2) } });
    await prisma.paste.update({ where: { id: publicIds[2]! }, data: { viewCount: BigInt(base + 1) } });

    const feed = await a.json('GET', '/api/v1/pastes?sort=popular&limit=50', { sendCookies: false });
    const counts = feed.body.data.map((s: { id: string }) => s.id);
    const first3 = counts.slice(0, 3);
    expect(first3).toContain(publicIds[0]);
    expect(first3).toContain(publicIds[1]);
    expect(counts.indexOf(publicIds[0]!)).toBeLessThan(counts.indexOf(publicIds[1]!));
    expect(counts.indexOf(publicIds[1]!)).toBeLessThan(counts.indexOf(publicIds[2]!));
  });

  it('computes trending from 48h daily aggregates into an ordered list', async () => {
    const today = new Date();
    const day = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    await prisma.pasteViewDaily.create({ data: { pasteId: publicIds[3]!, day: day(0), views: 500n } });
    await prisma.pasteViewDaily.create({ data: { pasteId: publicIds[4]!, day: day(1), views: 200n } });
    await prisma.pasteViewDaily.create({ data: { pasteId: publicIds[5]!, day: day(10), views: 9000n } }); // outside window

    await recomputeTrending();
    const feed = await a.json('GET', '/api/v1/pastes?sort=trending&limit=50', { sendCookies: false });
    const ids = feed.body.data.map((s: { id: string }) => s.id);
    expect(ids.indexOf(publicIds[3]!)).toBeLessThan(ids.indexOf(publicIds[4]!));
    expect(ids).not.toContain(publicIds[5]!); // 10-day-old views are outside the window
  });

  it('searches titles via FTS and never returns hidden content', async () => {
    const hit = await a.json('GET', '/api/v1/search?q=Alpha+paste', { sendCookies: false });
    expect(hit.status).toBe(200);
    const ids = hit.body.data.map((s: { id: string }) => s.id);
    expect(ids.some((id: string) => publicIds.includes(id))).toBe(true);
    for (const id of secretIds) expect(ids).not.toContain(id);

    const filtered = await a.json('GET', '/api/v1/search?q=Alpha+paste&language=python', { sendCookies: false });
    expect(filtered.body.data.every((s: { language: string | null }) => s.language === 'python')).toBe(true);

    const hidden = await a.json('GET', '/api/v1/search?q=unlisted+secret', { sendCookies: false });
    expect(hidden.body.data.length).toBe(0);

    const suspended = await a.json('GET', '/api/v1/search?q=suspended+content', { sendCookies: false });
    expect(suspended.body.data.length).toBe(0);

    const empty = await a.json('GET', '/api/v1/search?q=', { sendCookies: false });
    expect(empty.status).toBe(400);
  });

  it('exposes language facets for the filter UI', async () => {
    const facets = await a.json('GET', '/api/v1/languages', { sendCookies: false });
    expect(facets.status).toBe(200);
    const python = facets.body.data.find((f: { language: string }) => f.language === 'python');
    expect(python.count).toBeGreaterThanOrEqual(3);
  });

  it('lists only public pastes on the profile pastes endpoint', async () => {
    const list = await a.json('GET', `/api/v1/users/${userB}/pastes?limit=50`, { sendCookies: false });
    expect(list.status).toBe(200);
    const ids = list.body.data.map((s: { id: string }) => s.id);
    expect(ids.length).toBe(3);
    for (const id of secretIds) expect(ids).not.toContain(id);
    void getRedis;
  });
});
