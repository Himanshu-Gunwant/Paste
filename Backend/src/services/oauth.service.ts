import { createHash, timingSafeEqual } from 'node:crypto';
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_ENDPOINTS,
  OAUTH_STATE_TTL_SECONDS,
  USERNAME_MAX,
} from '../config/constants.js';
import { env, oauthEndpointOverrides } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { generateToken } from '../lib/tokens.js';
import { oauthAccountRepository } from '../repositories/oauth-account.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { createSession } from './session.service.js';
import type { OAuthProvider as OAuthProviderDb, User } from '../generated/prisma/client.js';

/**
 * OAuth (Google / GitHub) — authorization-code flow with single-use state
 * and PKCE where the provider supports it (docs/ARCHITECTURE.md §4 D).
 *
 * Security contract:
 *  - state (32-byte CSPRNG) travels in a single-use, 10-minute, httpOnly
 *    __Host-oauth cookie and is compared timing-safely on callback → OAuth CSRF.
 *  - PKCE S256 for Google. GitHub classic OAuth apps do not implement PKCE;
 *    the provider flag keeps this explicit (state remains GitHub's CSRF defense).
 *  - Only provider-VERIFIED emails may create or link accounts.
 *  - No refresh tokens stored; provider contact ends at login.
 */

export const OAUTH_PROVIDERS = ['google', 'github'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

interface ProviderProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

function endpoints(provider: OAuthProviderId) {
  const base = OAUTH_ENDPOINTS[provider];
  const overrides = oauthEndpointOverrides[provider] ?? {};
  return {
    auth: overrides.auth ?? base.auth,
    token: overrides.token ?? base.token,
    userinfo: 'userinfo' in base ? (overrides.userinfo ?? (base as { userinfo: string }).userinfo) : undefined,
    api: 'api' in base ? (overrides.api ?? (base as { api: string }).api) : undefined,
  };
}

/** URL-friendly provider ids (lowercase) map to the DB enum (SCREAMING). */
function toDbProvider(id: OAuthProviderId): OAuthProviderDb {
  return id === 'google' ? 'GOOGLE' : 'GITHUB';
}

function callbackUrl(provider: OAuthProviderId): string {
  return `${env.APP_BASE_URL}${OAUTH_CALLBACK_PATH}/${provider}/callback`;
}

function credentials(provider: OAuthProviderId): { clientId: string; clientSecret: string } {
  const clientId = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
  const clientSecret = provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw AppError.providerNotConfigured(provider);
  return { clientId, clientSecret };
}

const USES_PKCE: Record<OAuthProviderId, boolean> = { google: true, github: false };

export interface OAuthStateCookie {
  state: string;
  verifier?: string;
}

export interface StartResult {
  authorizeUrl: string;
  stateCookie: OAuthStateCookie;
  stateCookieMaxAgeSeconds: number;
}

export function start(provider: OAuthProviderId): StartResult {
  const { clientId } = credentials(provider);
  const ep = endpoints(provider);
  const state = generateToken(32);
  const usesPkce = USES_PKCE[provider];
  const verifier = usesPkce ? generateToken(64) : undefined;

  const redirectUri = callbackUrl(provider);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    ...(provider === 'google' ? { scope: 'openid email profile' } : { scope: 'read:user user:email' }),
  });
  if (usesPkce && verifier) {
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }

  return {
    authorizeUrl: `${ep.auth}?${params.toString()}`,
    stateCookie: verifier ? { state, verifier } : { state },
    stateCookieMaxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface CallbackInput {
  provider: OAuthProviderId;
  code: string | undefined;
  state: string | undefined;
  providerError: string | undefined;
  stateCookie: OAuthStateCookie | undefined;
  /** Present when the user is already logged in → link to that account. */
  currentUserId: string | undefined;
  ip: string | null;
  userAgent: string | null;
}

export interface CallbackResult {
  sessionToken: string;
  user: User;
  created: boolean;
  linked: boolean;
}

export async function handleCallback(input: CallbackInput): Promise<CallbackResult> {
  if (input.providerError) throw AppError.unauthorized('OAuth authorization was denied');
  if (!input.code || !input.state) throw AppError.validation('Missing OAuth code or state');
  if (!input.stateCookie) throw AppError.validation('Missing or expired OAuth state');

  // Single-use state comparison — timing-safe (docs/ARCHITECTURE.md §13).
  if (!timingSafeStringEqual(input.state, input.stateCookie.state)) {
    throw AppError.unauthorized('Invalid OAuth state');
  }

  const profile = await exchangeAndFetchProfile(input.provider, input.code, input.stateCookie);
  if (!profile.emailVerified) throw AppError.oauthEmailUnverified();

  return await linkAndSignIn(input, profile);
}

async function exchangeAndFetchProfile(
  provider: OAuthProviderId,
  code: string,
  stateCookie: OAuthStateCookie,
): Promise<ProviderProfile> {
  const { clientId, clientSecret } = credentials(provider);
  const ep = endpoints(provider);
  const redirectUri = callbackUrl(provider);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    ...(stateCookie.verifier ? { code_verifier: stateCookie.verifier } : {}),
  });

  const tokenRes = await fetch(ep.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!tokenRes.ok) throw AppError.unauthorized('OAuth token exchange failed');
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) throw AppError.unauthorized('OAuth token exchange failed');

  return provider === 'google' ? googleProfile(accessToken) : githubProfile(accessToken);
}

async function googleProfile(accessToken: string): Promise<ProviderProfile> {
  const ep = endpoints('google');
  const res = await fetch(ep.userinfo!, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw AppError.unauthorized('Failed to load Google profile');
  const data = (await res.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!data.email) throw AppError.oauthEmailUnverified();
  return {
    providerAccountId: data.sub,
    email: data.email.toLowerCase(),
    emailVerified: data.email_verified === true,
    displayName: data.name ?? null,
    avatarUrl: data.picture ?? null,
  };
}

async function githubProfile(accessToken: string): Promise<ProviderProfile> {
  const ep = endpoints('github');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'paste-backend' };

  const userRes = await fetch(`${ep.api}/user`, { headers });
  if (!userRes.ok) throw AppError.unauthorized('Failed to load GitHub profile');
  const user = (await userRes.json()) as { id: number; login?: string; name?: string; avatar_url?: string };

  const emailsRes = await fetch(`${ep.api}/user/emails`, { headers });
  let email: string | undefined;
  let emailVerified = false;
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((e) => e.primary) ?? emails[0];
    if (primary) {
      email = primary.email.toLowerCase();
      emailVerified = primary.verified;
    }
  }
  if (!email) throw AppError.oauthEmailUnverified();
  return {
    providerAccountId: String(user.id),
    email,
    emailVerified,
    displayName: user.name ?? user.login ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

async function linkAndSignIn(
  input: CallbackInput,
  profile: ProviderProfile,
): Promise<CallbackResult> {
  // 1. Returning identity → sign in (fresh session; no session reuse).
  const existing = await oauthAccountRepository.findByIdentity(toDbProvider(input.provider), profile.providerAccountId);
  if (existing) {
    const user = await userRepository.findById(existing.userId);
    if (!user || user.deletedAt || user.status === 'DELETED') throw AppError.unauthorized('Linked account no longer exists');
    if (user.status === 'SUSPENDED') throw AppError.forbidden('This account is suspended');
    const { token } = await createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent });
    return { sessionToken: token, user, created: false, linked: false };
  }

  // 2. Active session → link the provider to the current account.
  if (input.currentUserId) {
    const current = await userRepository.findById(input.currentUserId);
    if (!current || current.deletedAt || current.status !== 'ACTIVE') throw AppError.unauthorized();
    await oauthAccountRepository.create({
      userId: current.id,
      provider: toDbProvider(input.provider),
      providerAccountId: profile.providerAccountId,
    });
    const { token } = await createSession({ userId: current.id, ip: input.ip, userAgent: input.userAgent });
    return { sessionToken: token, user: current, created: false, linked: true };
  }

  // 3. Local account with the same (provider-verified) email → auto-link.
  const byEmail = await userRepository.findByEmail(profile.email);
  if (byEmail) {
    if (byEmail.deletedAt || byEmail.status === 'DELETED') throw AppError.conflict('This email belongs to a deleted account');
    if (byEmail.status === 'SUSPENDED') throw AppError.forbidden('This account is suspended');
    await oauthAccountRepository.create({
      userId: byEmail.id,
      provider: toDbProvider(input.provider),
      providerAccountId: profile.providerAccountId,
    });
    const { token } = await createSession({ userId: byEmail.id, ip: input.ip, userAgent: input.userAgent });
    return { sessionToken: token, user: byEmail, created: false, linked: true };
  }

  // 4. New account (provider-verified email ⇒ emailVerified from day one).
  const user = await createUserFromOAuthProfile(profile);
  await oauthAccountRepository.create({
    userId: user.id,
    provider: toDbProvider(input.provider),
    providerAccountId: profile.providerAccountId,
  });
  const { token } = await createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent });
  return { sessionToken: token, user, created: true, linked: false };
}

const USERNAME_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function deriveUsername(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, USERNAME_MAX - 7);
  return cleaned.length >= 3 ? cleaned : `user-${cleaned}`.slice(0, USERNAME_MAX);
}

async function createUserFromOAuthProfile(profile: ProviderProfile): Promise<User> {
  const base = deriveUsername(profile.email);
  let candidate = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await userRepository.create({
        email: profile.email,
        username: candidate,
        passwordHash: null,
        emailVerified: true,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });
    } catch {
      // Unique-constraint race on username (or the rare email race — both
      // resolved by re-deriving; email races land in rule 3 on next login).
      candidate = `${base}-${generateToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || USERNAME_ALPHABET.slice(0, 6)}`.slice(
        0,
        USERNAME_MAX,
      );
    }
  }
  throw AppError.conflict('Could not allocate a username; please register manually');
}
