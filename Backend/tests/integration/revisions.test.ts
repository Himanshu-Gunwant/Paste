import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * Phase 3 integration suite — revision visibility, diff, and the
 * append-only restore invariant.
 */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: revisions', () => {
  let owner: TestClient;
  let stranger: TestClient;
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();
  let ownerUsername = '';

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    owner = started.client;
    stranger = new TestClient(started.client.baseUrl);
    closeServer = started.close;

    ownerUsername = `revowner-${suffix}`.slice(0, 30);
    const reg = await owner.json('POST', '/api/v1/auth/register', {
      body: { email: `rev-${suffix}@example.test`, username: ownerUsername, password: PASSWORD },
    });
    expect(reg.status).toBe(201);
    await stranger.json('POST', '/api/v1/auth/register', {
      body: { email: `revs-${suffix}@example.test`, username: `revs-${suffix}`.slice(0, 30), password: PASSWORD },
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

  it('versions updates and lists revisions newest-first without content', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'version one', title: 'Original' },
    });
    const id = created.body.paste.id as string;

    await owner.json('PATCH', `/api/v1/pastes/${id}`, { body: { content: 'version two' } });
    await owner.json('PATCH', `/api/v1/pastes/${id}`, { body: { content: 'version three' } });

    const list = await owner.json('GET', `/api/v1/pastes/${id}/revisions`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { revisionNo: number }) => r.revisionNo)).toEqual([3, 2, 1]);
    expect(list.body.data.every((r: { content?: string }) => r.content === undefined)).toBe(true);
    expect(list.body.latestRevisionNo).toBe(3);
  });

  it('returns a single revision snapshot with content', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'historic content' },
    });
    const id = created.body.paste.id as string;
    await owner.json('PATCH', `/api/v1/pastes/${id}`, { body: { content: 'current content' } });

    const rev1 = await owner.json('GET', `/api/v1/pastes/${id}/revisions/1`);
    expect(rev1.status).toBe(200);
    expect(rev1.body.revision.content).toBe('historic content');
    expect(rev1.body.revision.revisionNo).toBe(1);

    const missing = await owner.json('GET', `/api/v1/pastes/${id}/revisions/99`);
    expect(missing.status).toBe(404);
  });

  it('computes a unified diff between two revisions on demand', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'line one\nline two\n' },
    });
    const id = created.body.paste.id as string;
    await owner.json('PATCH', `/api/v1/pastes/${id}`, { body: { content: 'line one\nline TWO changed\n' } });

    const diff = await owner.json('GET', `/api/v1/pastes/${id}/revisions/1/diff?to=2`);
    expect(diff.status).toBe(200);
    expect(diff.body.from).toBe(1);
    expect(diff.body.to).toBe(2);
    expect(diff.body.diff).toContain('-line two');
    expect(diff.body.diff).toContain('+line TWO changed');

    const same = await owner.json('GET', `/api/v1/pastes/${id}/revisions/2/diff?to=2`);
    expect(same.status).toBe(400);
  });

  it('restores an old revision as a NEW revision (history never rewritten)', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'the original', title: 'Orig title' },
    });
    const id = created.body.paste.id as string;
    await owner.json('PATCH', `/api/v1/pastes/${id}`, { body: { content: 'the edit', title: 'Edited title' } });

    const restore = await owner.json('POST', `/api/v1/pastes/${id}/revisions/1/restore`);
    expect(restore.status).toBe(200);
    expect(restore.body.restored).toBe(true);
    expect(restore.body.latestRevisionNo).toBe(3);

    const paste = await prisma.paste.findUnique({ where: { id } });
    expect(paste?.content).toBe('the original');
    expect(paste?.title).toBe('Orig title'); // snapshot metadata restored too

    // History is append-only: revision 2 still shows the edit, revision 3 == restore.
    const rev2 = await owner.json('GET', `/api/v1/pastes/${id}/revisions/2`);
    expect(rev2.body.revision.content).toBe('the edit');
    const rev3 = await owner.json('GET', `/api/v1/pastes/${id}/revisions/3`);
    expect(rev3.body.revision.content).toBe('the original');

    // Restoring the identical current revision is a no-op (no history noise).
    const noop = await owner.json('POST', `/api/v1/pastes/${id}/revisions/3/restore`);
    expect(noop.body.restored).toBe(false);
    expect((await prisma.pasteRevision.count({ where: { pasteId: id } }))).toBe(3);
  });

  it('denies restore to strangers with the uniform 404', async () => {
    const created = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'a', visibility: 'public' },
    });
    await owner.json('PATCH', `/api/v1/pastes/${created.body.paste.id}`, { body: { content: 'b' } });

    const strangerRestore = await stranger.json(
      'POST',
      `/api/v1/pastes/${created.body.paste.id}/revisions/1/restore`,
    );
    expect(strangerRestore.status).toBe(404);
  });

  it('applies paste visibility to revision reads (private/unlisted/password)', async () => {
    const privatePaste = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'private v1', visibility: 'private' },
    });
    await owner.json('PATCH', `/api/v1/pastes/${privatePaste.body.paste.id}`, { body: { content: 'private v2' } });
    expect((await stranger.json('GET', `/api/v1/pastes/${privatePaste.body.paste.id}/revisions`)).status).toBe(404);
    expect((await owner.json('GET', `/api/v1/pastes/${privatePaste.body.paste.id}/revisions`)).status).toBe(200);

    const locked = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'locked v1', password: 'rev-pw-7' },
    });
    const lockedId = locked.body.paste.id as string;
    await owner.json('PATCH', `/api/v1/pastes/${lockedId}`, { body: { content: 'locked v2' } });

    const anonNoPassword = await stranger.json('GET', `/api/v1/pastes/${lockedId}/revisions`, { sendCookies: false });
    expect(anonNoPassword.status).toBe(401);
    expect(anonNoPassword.body.error.code).toBe('PASSWORD_REQUIRED');

    const anonWithPassword = await stranger.json('GET', `/api/v1/pastes/${lockedId}/revisions`, {
      sendCookies: false,
      headers: { 'x-paste-password': 'rev-pw-7' },
    });
    expect(anonWithPassword.status).toBe(200);
    expect(anonWithPassword.body.data.length).toBe(2);

    const wrongPassword = await stranger.json('GET', `/api/v1/pastes/${lockedId}/revisions/1`, {
      sendCookies: false,
      headers: { 'x-paste-password': 'nope' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_PASSWORD');
  });

  it('hides revisions of consumed burn pastes', async () => {
    const burn = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'burn me', burnAfterRead: true },
    });
    const id = burn.body.paste.id as string;

    const before = await stranger.json('GET', `/api/v1/pastes/${id}/revisions`, { sendCookies: false });
    expect(before.status).toBe(200);

    await stranger.json('GET', `/api/v1/pastes/${id}`, { sendCookies: false }); // consumes

    const after = await stranger.json('GET', `/api/v1/pastes/${id}/revisions`, { sendCookies: false });
    expect(after.status).toBe(404);
  });
});
