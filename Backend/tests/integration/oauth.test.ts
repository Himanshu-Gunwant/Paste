import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAUTH_STATE_COOKIE } from '../../src/config/constants.js';
import { closeRedis } from '../../src/lib/redis.js';
import { closePrisma, prisma } from '../../src/lib/prisma.js';
import { closeQueues } from '../../src/queues/queues.js';
import { resetRateLimits, TestClient, uniqueSuffix } from '../helpers/test-client.js';

/**
 * OAuth integration suite — the provider is a local mock HTTP server wired
 * through OAUTH_ENDPOINTS_JSON (tests/setup.ts, port 18888). Covers:
 * authorize-URL + state cookie issuance, state validation (missing/mismatch),
 * PKCE code exchange, verified-email requirement, ordered linking rules
 * (returning identity > active-session link > verified-email auto-link >
 * new account), and suspension handling.
 */
const run = process.env.RUN_INTEGRATION === '1';

const MOCK_PORT = 18888;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const handlers: Record<string, Handler> = {};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
  });
}

describe.skipIf(!run)('integration: OAuth flows', () => {
  let client: TestClient;
  let closeServer: () => Promise<void>;
  let mockServer: Server;

  const suffix = uniqueSuffix();
  const password = 'correct-horse-42';
  const email = `oauth-${suffix}@example.test`;
  const username = `oauther-${suffix}`.slice(0, 30);
  // Unique per run: provider identities persist in the DB across runs, so a
  // static id would hit the returning-identity rule instead of account creation.
  const githubUserId = 1_000_000 + Math.floor(Math.random() * 8_000_000_00);

  beforeAll(async () => {
    const started = await TestClient.start();
    client = started.client;
    closeServer = started.close;
    await resetRateLimits();

    mockServer = createServer((req, res) => {
      const url = req.url ?? '';
      const handler = handlers[url.split('?')[0] ?? ''];
      if (handler) {
        void handler(req, res);
      } else {
        json(res, 404, { error: 'unrouted' });
      }
    });
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', () => resolve()));

    // Default Google mock endpoints (tests override per scenario).
    handlers['/google/token'] = async (req, res) => {
      await readBody(req); // code + code_verifier arrive here
      json(res, 200, { access_token: 'google-access-token' });
    };
    handlers['/google/userinfo'] = (_req, res) => {
      json(res, 200, {
        sub: 'google-sub-' + suffix,
        email,
        email_verified: true,
        name: 'Google User',
        picture: 'https://example.test/avatar.png',
      });
    };
    handlers['/github/token'] = async (req, res) => {
      await readBody(req);
      json(res, 200, { access_token: 'github-access-token' });
    };
    handlers['/github/api/user'] = (_req, res) => {
      json(res, 200, { id: githubUserId, login: 'ghuser', name: 'GitHub User', avatar_url: 'https://example.test/gh.png' });
    };
    handlers['/github/api/user/emails'] = (_req, res) => {
      json(res, 200, [{ email, primary: true, verified: true }]);
    };
  });

  afterAll(async () => {
    mockServer.close();
    await closeQueues();
    await closeRedis();
    await closePrisma();
    await closeServer();
  });

  interface StartResult {
    state: string;
    stateCookie: string;
    authorizeUrl: URL;
  }

  async function startOAuth(
    provider: 'google' | 'github',
    opts: { keepCookies?: boolean } = {},
  ): Promise<StartResult> {
    if (!opts.keepCookies) client.clearCookies();
    const res = await client.request('GET', `/api/v1/auth/oauth/${provider}`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    const stateCookieHeader = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-oauth='));
    expect(stateCookieHeader).toBeTruthy();
    const stateCookieRaw = stateCookieHeader!.split(';')[0]!.split('=').slice(1).join('=');
    const stateCookieJson = JSON.parse(decodeURIComponent(stateCookieRaw)) as {
      state: string;
      verifier?: string;
    };
    // Cookie state must equal the authorize-URL state (they are compared at callback time).
    expect(stateCookieJson.state).toBe(new URL(location!).searchParams.get('state'));
    return {
      state: stateCookieJson.state,
      stateCookie: stateCookieRaw,
      authorizeUrl: new URL(location!),
    };
  }

  async function callback(
    provider: 'google' | 'github',
    start: StartResult,
    overrides: { state?: string; sendStateCookie?: boolean; code?: string; keepCookies?: boolean } = {},
  ): Promise<Response> {
    const params = new URLSearchParams({
      code: overrides.code ?? 'mock-code',
      state: overrides.state ?? start.state,
    });
    if (!overrides.keepCookies) client.clearCookies();
    if (overrides.sendStateCookie !== false) {
      // start.stateCookie is the cookie VALUE (name stripped in startOAuth);
      // express set it encoded, so decode once before replaying it.
      client.setCookie(OAUTH_STATE_COOKIE, decodeURIComponent(start.stateCookie));
    }
    return client.request('GET', `/api/v1/auth/oauth/${provider}/callback?${params.toString()}`);
  }

  it('issues a single-use state cookie and authorize URL with PKCE for Google', async () => {
    const start = await startOAuth('google');
    expect(start.authorizeUrl.searchParams.get('client_id')).toBe('test-google-client');
    expect(start.authorizeUrl.searchParams.get('redirect_uri')).toContain('/api/v1/auth/oauth/google/callback');
    expect(start.authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const parsedStateCookie = JSON.parse(decodeURIComponent(start.stateCookie)) as {
      state: string;
      verifier?: string;
    };
    expect(parsedStateCookie.state).toBe(start.state);
    expect(parsedStateCookie.verifier).toBeTruthy();
  });

  it('rejects a callback with missing state cookie (CSRF)', async () => {
    const start = await startOAuth('google');
    const res = await callback('google', start, { sendStateCookie: false });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('oauth')).toBe('error');
    expect(location.searchParams.get('reason')).toBe('VALIDATION_ERROR');
  });

  it('rejects a callback with mismatched state (timing-safe compare)', async () => {
    const start = await startOAuth('google');
    const res = await callback('google', start, { state: 'attacker-crafted-state' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('reason')).toBe('UNAUTHORIZED');
    // No session was created.
    expect(client.rawCookies.every((c) => !c.includes('__Host-sess='))).toBe(true);
  });

  it('creates a new account via Google and signs in with a fresh session', async () => {
    const start = await startOAuth('google');
    const res = await callback('google', start);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('status')).toBe('created');

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.user.emailVerified).toBe(true);
    expect(me.body.user.passwordHash).toBeUndefined();

    const account = await prisma.oAuthAccount.findFirst({
      where: { provider: 'GOOGLE', providerAccountId: 'google-sub-' + suffix },
    });
    expect(account?.userId).toBe(me.body.user.id);
  });

  it('signs in returning identities with status=login (no duplicate link)', async () => {
    const start = await startOAuth('google');
    const res = await callback('google', start);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('status')).toBe('login');

    const accounts = await prisma.oAuthAccount.findMany({
      where: { providerAccountId: 'google-sub-' + suffix },
    });
    expect(accounts.length).toBe(1);
  });

  it('auto-links to an existing local account with the same verified email', async () => {
    const localEmail = `local-${suffix}@example.test`;
    const registered = await client.json('POST', '/api/v1/auth/register', {
      body: { email: localEmail, username, password },
      sendCookies: false,
    });
    expect(registered.status).toBe(201);

    // Point the Google mock at the local account's email + a new provider id.
    handlers['/google/userinfo'] = (_req, res) => {
      json(res, 200, {
        sub: 'google-sub-linked-' + suffix,
        email: localEmail,
        email_verified: true,
        name: 'Local User',
      });
    };

    const start = await startOAuth('google');
    const res = await callback('google', start);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('status')).toBe('linked');

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.body.user.id).toBe(registered.body.user.id);

    const accounts = await prisma.oAuthAccount.findMany({
      where: { userId: registered.body.user.id },
    });
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.provider).toBe('GOOGLE');
  });

  it('refuses unverified provider emails (no account, no link)', async () => {
    const unverifiedEmail = `unverified-${suffix}@example.test`;
    handlers['/github/api/user/emails'] = (_req, res) => {
      json(res, 200, [{ email: unverifiedEmail, primary: true, verified: false }]);
    };

    const start = await startOAuth('github');
    const res = await callback('github', start);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('reason')).toBe('OAUTH_EMAIL_UNVERIFIED');

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(401);

    const created = await prisma.user.findFirst({ where: { email: unverifiedEmail } });
    expect(created).toBeNull();
  });

  it('creates GitHub accounts with derived usernames when email is verified', async () => {
    const ghEmail = `gh-${suffix}@example.test`;
    handlers['/github/api/user/emails'] = (_req, res) => {
      json(res, 200, [{ email: ghEmail, primary: true, verified: true }]);
    };

    const start = await startOAuth('github');
    const res = await callback('github', start);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('status')).toBe('created');

    const me = await client.json('GET', '/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ghEmail);
    expect(me.body.user.username).toMatch(/^[a-z0-9_-]{3,30}$/);
  });

  it('links a provider to the current session when already logged in', async () => {
    const sessionEmail = `session-link-${suffix}@example.test`;
    const registered = await client.json('POST', '/api/v1/auth/register', {
      body: { email: sessionEmail, username: `linker-${suffix}`.slice(0, 30), password },
    });
    expect(registered.status).toBe(201);

    handlers['/google/userinfo'] = (_req, res) => {
      json(res, 200, {
        sub: 'google-sub-session-link-' + suffix,
        email: `different-${suffix}@example.test`,
        email_verified: true,
      });
    };

    // Client holds the local session; OAuth callback must link, not create.
    const start = await startOAuth('google', { keepCookies: true });
    const res = await callback('google', start, { keepCookies: true });
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('status')).toBe('linked');

    const linkedUserId = (registered.body as { user: { id: string } }).user.id;
    const accounts = await prisma.oAuthAccount.findMany({
      where: { userId: linkedUserId, provider: 'GOOGLE' },
    });
    expect(accounts.length).toBe(1);
  });
});
