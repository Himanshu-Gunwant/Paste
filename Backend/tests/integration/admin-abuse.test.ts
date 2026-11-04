import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/** Phase 8 integration suite — reports, auto-unlist, moderation, audit trail, IP bans. */
const run = process.env.RUN_INTEGRATION === '1';
const PASSWORD = 'correct-horse-42';

describe.skipIf(!run)('integration: abuse & administration', () => {
  let admin: TestClient;
  let user: TestClient;
  let stranger: TestClient;
  let closeServer: () => Promise<void>;
  const suffix = uniqueSuffix();
  let adminId = '';
  let userId = '';
  let bannedUserId = '';

  beforeAll(async () => {
    await resetRateLimits();
    const started = await TestClient.start();
    admin = started.client;
    user = new TestClient(started.client.baseUrl);
    stranger = new TestClient(started.client.baseUrl);
    closeServer = started.close;

    const reg = await user.json('POST', '/api/v1/auth/register', {
      body: { email: `mod-${suffix}@example.test`, username: `moduser-${suffix}`.slice(0, 30), password: PASSWORD },
    });
    userId = reg.body.user.id;

    const adminRow = await prisma.user.create({
      data: {
        email: `admin-${suffix}@example.test`,
        username: `admin-${suffix}`.slice(0, 30),
        passwordHash: null,
        role: 'ADMIN',
        emailVerified: true,
      },
    });
    adminId = adminRow.id;
    const { createSession } = await import('../../src/services/session.service.js');
    const { token } = await createSession({ userId: adminId, ip: null, userAgent: 'vitest' });
    admin.setCookie('__Host-sess', token);

    const bannedRow = await prisma.user.create({
      data: {
        email: `banned-${suffix}@example.test`,
        username: `banned-${suffix}`.slice(0, 30),
        passwordHash: null,
        emailVerified: true,
      },
    });
    bannedUserId = bannedRow.id;
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

  it('requires ADMIN for the admin surface', async () => {
    const denied = await user.json('GET', '/api/v1/admin/stats');
    expect(denied.status).toBe(403);
    const anon = await stranger.json('GET', '/api/v1/admin/stats', { sendCookies: false });
    expect(anon.status).toBe(401);
  });

  it('accepts anonymous reports with hashed reporter identity', async () => {
    const created = await user.json('POST', '/api/v1/pastes', {
      body: { content: 'reportable', visibility: 'public' },
    });
    const id = created.body.paste.id as string;

    const reported = await stranger.json('POST', '/api/v1/reports', {
      body: { pasteId: id, reason: 'SPAM', details: 'spam content' },
      sendCookies: false,
    });
    expect(reported.status).toBe(201);
    expect(reported.body.status).toBe('OPEN');

    const row = await prisma.abuseReport.findUnique({ where: { id: reported.body.id } });
    expect(row?.reporterId).toBeNull();
    expect(row?.reporterIpHash).toMatch(/^[0-9a-f]{64}$/);

    const missing = await stranger.json('POST', '/api/v1/reports', {
      body: { pasteId: 'doesnotexist1', reason: 'SPAM' },
      sendCookies: false,
    });
    expect(missing.status).toBe(404);

    const invalid = await stranger.json('POST', '/api/v1/reports', {
      body: { pasteId: id, reason: 'NOT_A_REASON' },
      sendCookies: false,
    });
    expect(invalid.status).toBe(400);
  });

  it('auto-unlists a PUBLIC paste once open reports reach the threshold', async () => {
    const created = await user.json('POST', '/api/v1/pastes', {
      body: { content: 'spammy', visibility: 'public' },
    });
    const id = created.body.paste.id as string;

    for (let i = 0; i < 3; i++) {
      const report = await stranger.json('POST', '/api/v1/reports', {
        body: { pasteId: id, reason: 'SPAM' },
        sendCookies: false,
      });
      expect(report.status).toBe(201);
    }

    const row = await prisma.paste.findUnique({ where: { id } });
    expect(row?.visibility).toBe('UNLISTED');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'paste.auto_unlist', targetId: id } });
    expect(audit).not.toBeNull();
  });

  it('resolves reports: dismiss keeps content, delete_paste moderates it away', async () => {
    const keep = await user.json('POST', '/api/v1/pastes', { body: { content: 'innocent' } });
    const guilty = await user.json('POST', '/api/v1/pastes', { body: { content: 'guilty' } });

    const reportKeep = await stranger.json('POST', '/api/v1/reports', {
      body: { pasteId: keep.body.paste.id, reason: 'OTHER' },
      sendCookies: false,
    });
    const reportGuilty = await stranger.json('POST', '/api/v1/reports', {
      body: { pasteId: guilty.body.paste.id, reason: 'MALWARE' },
      sendCookies: false,
    });

    const dismissed = await admin.json('POST', `/api/v1/admin/reports/${reportKeep.body.id}/resolve`, {
      body: { action: 'dismiss', note: 'not a violation' },
    });
    expect(dismissed.status).toBe(204);
    const keptRow = await prisma.paste.findUnique({ where: { id: keep.body.paste.id } });
    expect(keptRow?.deletedAt).toBeNull();

    const resolved = await admin.json('POST', `/api/v1/admin/reports/${reportGuilty.body.id}/resolve`, {
      body: { action: 'delete_paste' },
    });
    expect(resolved.status).toBe(204);
    const guiltyRow = await prisma.paste.findUnique({ where: { id: guilty.body.paste.id } });
    expect(guiltyRow?.deletedAt).not.toBeNull();
    expect(guiltyRow?.deletedBy).toBe('MODERATOR');

    const double = await admin.json('POST', `/api/v1/admin/reports/${reportGuilty.body.id}/resolve`, {
      body: { action: 'dismiss' },
    });
    expect(double.status).toBe(409);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'paste.moderator_delete', targetId: guilty.body.paste.id } });
    expect(audit?.actorType).toBe('ADMIN');
    expect(audit?.actorName).toBe(`admin-${suffix}`.slice(0, 30));
  });

  it('suspends users (sessions + keys revoked) and unsuspends, all audited', async () => {
    // Login the target so we can watch the session die.
    const targetClient = new TestClient(user.baseUrl);
    const targetEmail = (await prisma.user.findUnique({ where: { id: bannedUserId } }))!.email;
    const login = await targetClient.json('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: PASSWORD },
      sendCookies: false,
    }).catch(() => null);
    // The banned row has no password — create one directly for login testing.
    const { hashPassword } = await import('../../src/lib/crypto.js');
    await prisma.user.update({
      where: { id: bannedUserId },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
    const realLogin = await targetClient.json('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: PASSWORD },
      sendCookies: false,
    });
    expect(realLogin.status).toBe(200);
    void login;

    const suspend = await admin.json('POST', `/api/v1/admin/users/${bannedUserId}/suspend`, {
      body: { reason: 'abuse wave' },
    });
    expect(suspend.status).toBe(204);

    const sessionDead = await targetClient.json('GET', '/api/v1/users/me');
    expect(sessionDead.status).toBe(401);

    const loginBlocked = await targetClient.json('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: PASSWORD },
      sendCookies: false,
    });
    expect(loginBlocked.status).toBe(403);
    expect(loginBlocked.body.error.message).toContain('suspended');

    const restriction = await prisma.userRestriction.findFirst({ where: { userId: bannedUserId } });
    expect(restriction?.type).toBe('SUSPENSION');
    expect(restriction?.endsAt).toBeNull();

    const unsuspend = await admin.json('POST', `/api/v1/admin/users/${bannedUserId}/unsuspend`);
    expect(unsuspend.status).toBe(204);
    const reLogin = await targetClient.json('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: PASSWORD },
      sendCookies: false,
    });
    expect(reLogin.status).toBe(200);

    const adminProtected = await prisma.user.findUnique({ where: { id: adminId } });
    const suspendAdmin = await admin.json('POST', `/api/v1/admin/users/${adminProtected!.id}/suspend`, {
      body: { reason: 'self-test' },
    });
    expect(suspendAdmin.status).toBe(403);
  });

  it('bans and unbans IPs with enforcement on anonymous writes', async () => {
    // The integration client is served from 127.0.0.1 (mapped or raw).
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
      const ban = await admin.json('POST', '/api/v1/admin/ip-bans', {
        body: { ip, reason: 'spam wave' },
      });
      if (ban.status === 201) {
        const blocked = await stranger.json('POST', '/api/v1/pastes', {
          body: { content: 'should be blocked' },
          sendCookies: false,
        });
        expect(blocked.status).toBe(403);
        expect(blocked.body.error.message).toContain('not allowed');

        // Authenticated users bypass the IP guard (account-level controls).
        const authed = await user.json('POST', '/api/v1/pastes', { body: { content: 'authed ok' } });
        expect(authed.status).toBe(201);

        const bans = await admin.json('GET', '/api/v1/admin/ip-bans');
        const created = bans.body.data[0] as { id: string };
        const unbanned = await admin.json('DELETE', `/api/v1/admin/ip-bans/${created.id}`);
        expect(unbanned.status).toBe(204);
        return;
      }
    }
    // If none of the IPs matched the observed socket peer, fail loudly.
    expect.fail('no IP ban matched the test client address');
  });

  it('exposes admin stats and audit logs', async () => {
    const stats = await admin.json('GET', '/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    expect(Number(stats.body.users)).toBeGreaterThanOrEqual(3);
    expect(Number(stats.body.openReports)).toBeGreaterThanOrEqual(0);

    const users = await admin.json('GET', '/api/v1/admin/users?q=mod');
    expect(users.body.data.length).toBeGreaterThanOrEqual(1);

    const logs = await admin.json('GET', '/api/v1/admin/audit-logs?limit=20');
    expect(logs.status).toBe(200);
    expect(logs.body.data.length).toBeGreaterThan(0);
    expect(logs.body.data.some((l: { action: string }) => l.action === 'user.suspend')).toBe(true);
  });

  it('hard-purges a paste on admin command (row gone, cascades)', async () => {
    const created = await user.json('POST', '/api/v1/pastes', { body: { content: 'purge me' } });
    const id = created.body.paste.id as string;
    // creation already made revision 1 — cascade removes it with the row.

    const purge = await admin.json('POST', `/api/v1/admin/pastes/${id}/purge`);
    expect(purge.status).toBe(204);
    expect(await prisma.paste.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.pasteRevision.count({ where: { pasteId: id } })).toBe(0); // cascade

    const purgeMissing = await admin.json('POST', '/api/v1/admin/pastes/nothere12/purge');
    expect(purgeMissing.status).toBe(404);
  });
});
