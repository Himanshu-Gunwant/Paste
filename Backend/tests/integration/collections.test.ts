import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/** Phase 6 integration suite — collections, restricted-item leak rule, bookmarks. */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: collections & bookmarks', () => {
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

    ownerUsername = `colowner-${suffix}`.slice(0, 30);
    await owner.json('POST', '/api/v1/auth/register', {
      body: { email: `col-${suffix}@example.test`, username: ownerUsername, password: PASSWORD },
    });
    await stranger.json('POST', '/api/v1/auth/register', {
      body: { email: `cols-${suffix}@example.test`, username: `colstr-${suffix}`.slice(0, 30), password: PASSWORD },
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

  it('creates, lists, updates and deletes own collections with per-owner slugs', async () => {
    const created = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'My snippets', visibility: 'public' },
    });
    expect(created.status).toBe(201);
    expect(created.body.collection.slug).toBe('my-snippets');
    expect(created.body.collection.visibility).toBe('public');

    const dup = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Another', slug: 'my-snippets' },
    });
    expect(dup.status).toBe(409);

    // Same slug is fine for a different owner.
    const strangerSlug = await stranger.json('POST', '/api/v1/collections', {
      body: { title: 'Stranger stuff', slug: 'my-snippets' },
    });
    expect(strangerSlug.status).toBe(201);

    const reserved = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Bad', slug: 'admin' },
    });
    expect(reserved.status).toBe(400);

    const list = await owner.json('GET', '/api/v1/collections');
    expect(list.body.data.length).toBe(1); // the duplicate was rejected

    const patched = await owner.json('PATCH', `/api/v1/collections/${created.body.collection.id}`, {
      body: { description: 'updated' },
    });
    expect(patched.body.collection.description).toBe('updated');

    const strangerDeleted = await stranger.json('DELETE', `/api/v1/collections/${strangerSlug.body.collection.id}`);
    expect(strangerDeleted.status).toBe(204);
    const crossDelete = await stranger.json('DELETE', `/api/v1/collections/${created.body.collection.id}`);
    expect(crossDelete.status).toBe(404); // not their collection
  });

  it('adds, reorders, and removes items with position compaction', async () => {
    const collection = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Ordered', visibility: 'private' },
    });
    const id = collection.body.collection.id as string;

    const p1 = await owner.json('POST', '/api/v1/pastes', { body: { content: 'one' } });
    const p2 = await owner.json('POST', '/api/v1/pastes', { body: { content: 'two' } });
    const p3 = await owner.json('POST', '/api/v1/pastes', { body: { content: 'three' } });

    await owner.json('POST', `/api/v1/collections/${id}/pastes`, { body: { pasteId: p1.body.paste.id } });
    await owner.json('POST', `/api/v1/collections/${id}/pastes`, { body: { pasteId: p2.body.paste.id } });
    const third = await owner.json('POST', `/api/v1/collections/${id}/pastes`, {
      body: { pasteId: p3.body.paste.id },
    });
    expect(third.body.position).toBe(2);

    const duplicate = await owner.json('POST', `/api/v1/collections/${id}/pastes`, {
      body: { pasteId: p1.body.paste.id },
    });
    expect(duplicate.status).toBe(409);

    const reorder = await owner.json('PATCH', `/api/v1/collections/${id}/pastes`, {
      body: { positions: [
        { pasteId: p3.body.paste.id, position: 0 },
        { pasteId: p1.body.paste.id, position: 1 },
        { pasteId: p2.body.paste.id, position: 2 },
      ] },
    });
    expect(reorder.status).toBe(200);

    const view = await owner.json('GET', `/api/v1/collections/${id}`);
    expect(view.body.items.map((i: { paste?: { id: string } }) => i.paste?.id)).toEqual([
      p3.body.paste.id,
      p1.body.paste.id,
      p2.body.paste.id,
    ]);

    // Remove the middle item — positions compact.
    await owner.json('DELETE', `/api/v1/collections/${id}/pastes/${p1.body.paste.id}`);
    const after = await owner.json('GET', `/api/v1/collections/${id}`);
    expect(after.body.items.map((i: { position: number }) => i.position)).toEqual([0, 1]);

    const notIn = await stranger.json('DELETE', `/api/v1/collections/${id}/pastes/${p3.body.paste.id}`);
    expect(notIn.status).toBe(404); // stranger cannot manage someone's collection
  });

  it('applies collection visibility and restricted-item leak protection', async () => {
    const privateCollection = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Secret list', visibility: 'private' },
    });
    const strangerView = await stranger.json('GET', `/api/v1/collections/${privateCollection.body.collection.id}`);
    expect(strangerView.status).toBe(404);

    const publicCollection = await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Public list', visibility: 'public' },
    });
    const publicId = publicCollection.body.collection.id as string;

    // Public paste (from another user) + owner's private paste inside.
    const publicPaste = await stranger.json('POST', '/api/v1/pastes', {
      body: { content: 'shared snippet', title: 'Shared' },
      sendCookies: false,
    });
    const privatePaste = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'hidden snippet', visibility: 'private' },
    });
    await owner.json('POST', `/api/v1/collections/${publicId}/pastes`, {
      body: { pasteId: publicPaste.body.paste.id },
    });
    await owner.json('POST', `/api/v1/collections/${publicId}/pastes`, {
      body: { pasteId: privatePaste.body.paste.id },
    });

    const strangerItems = await stranger.json('GET', `/api/v1/collections/${publicId}`);
    expect(strangerItems.status).toBe(200);
    const items = strangerItems.body.items as { restricted?: boolean; paste?: { id: string; title: string | null } }[];
    const shared = items.find((i) => i.paste?.id === publicPaste.body.paste.id);
    expect(shared?.paste?.title).toBe('Shared');
    const restricted = items.find((i) => i.restricted === true);
    expect(restricted).toBeDefined();
    expect(JSON.stringify(items)).not.toContain(privatePaste.body.paste.id); // NO id leak
    expect(JSON.stringify(items)).not.toContain('hidden snippet');

    const ownerItems = await owner.json('GET', `/api/v1/collections/${publicId}`);
    expect(ownerItems.body.items.filter((i: { restricted?: boolean }) => i.restricted === true).length).toBe(0);

    // Adding an invisible paste is impossible for a stranger.
    const strangerAdd = await stranger.json('POST', `/api/v1/collections/${publicId}/pastes`, {
      body: { pasteId: privatePaste.body.paste.id },
    });
    expect(strangerAdd.status).toBe(404);
  });

  it('lists only public collections on the public profile', async () => {
    await owner.json('POST', '/api/v1/collections', {
      body: { title: 'Hidden col', visibility: 'unlisted' },
    });
    const list = await stranger.json('GET', `/api/v1/users/${ownerUsername}/collections`);
    expect(list.status).toBe(200);
    expect(list.body.data.every((c: { visibility: string }) => c.visibility === 'public')).toBe(true);
  });

  it('handles bookmarks idempotently with viewability gating', async () => {
    const target = await stranger.json('POST', '/api/v1/pastes', {
      body: { content: 'bookmarkable' },
      sendCookies: false,
    });
    const id = target.body.paste.id as string;

    const first = await owner.json('PUT', `/api/v1/pastes/${id}/bookmark`);
    expect(first.status).toBe(204);
    const repeat = await owner.json('PUT', `/api/v1/pastes/${id}/bookmark`);
    expect(repeat.status).toBe(204); // idempotent

    const list = await owner.json('GET', '/api/v1/users/me/bookmarks');
    expect(list.body.data.filter((b: { pasteId: string }) => b.pasteId === id).length).toBe(1);

    const removed = await owner.json('DELETE', `/api/v1/pastes/${id}/bookmark`);
    expect(removed.status).toBe(204);
    const removedAgain = await owner.json('DELETE', `/api/v1/pastes/${id}/bookmark`);
    expect(removedAgain.status).toBe(204); // idempotent
    expect((await prisma.bookmark.count({ where: { pasteId: id } }))).toBe(0);

    // Invisible pastes cannot be bookmarked.
    const privatePaste = await owner.json('POST', '/api/v1/pastes', {
      body: { content: 'secret', visibility: 'private' },
    });
    const denied = await stranger.json('PUT', `/api/v1/pastes/${privatePaste.body.paste.id}/bookmark`);
    expect(denied.status).toBe(404);
  });
});
