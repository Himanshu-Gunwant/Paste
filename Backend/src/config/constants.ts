/**
 * Central constants — single source of truth for limits, quotas and retention
 * referenced by validators, services and workers (docs/ARCHITECTURE.md §5.2,
 * §7.1, §12). Values here are the approved architecture defaults; operational
 * overrides come through env in later phases.
 */

/** Maximum paste content size in bytes (app-level; Nginx caps the body at 2 MB). */
export const MAX_PASTE_CONTENT_BYTES = 1_000_000;

/** Express JSON body limit — slightly above the paste cap to admit metadata. */
export const REQUEST_BODY_LIMIT = '1.1mb';

/** Tombstone retention before hard purge, keyed by deletion cause. */
export const TOMBSTONE_RETENTION_DAYS = {
  SYSTEM: 7, // expiry / burn / moderation
  USER: 30, // owner-initiated deletion
} as const;

/** Revisions kept per paste (drop-oldest beyond this). */
export const MAX_REVISIONS_PER_PASTE = 20;

/** Pagination defaults and hard caps (keyset cursor everywhere user-facing). */
export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 50,
} as const;

/** Reserved words that can never be usernames or custom slugs. */
export const RESERVED_WORDS = new Set([
  'admin', 'administrator', 'api', 'about', 'account', 'auth', 'login', 'logout',
  'register', 'signup', 'settings', 'docs', 'help', 'embed', 'explore', 'search',
  'trending', 'popular', 'latest', 'new', 'pastes', 'paste', 'collections',
  'bookmarks', 'users', 'user', 'me', 'profile', 'static', 'assets', 'cdn',
  'metrics', 'healthz', 'readyz', 'reports', 'support', 'legal', 'privacy',
  'terms', 'robots', 'favicon', 'manifest', 'sitemap', 'u', 'p', 'c',
]);

/** Rate limits (requests per window) — consumed by middleware in Phase 2+. */
export const RATE_LIMITS = {
  GLOBAL_PER_IP: { limit: 300, windowSeconds: 60 },
  AUTH: { limit: 10, windowSeconds: 15 * 60 },
  LOGIN_PER_EMAIL: { limit: 5, windowSeconds: 3600 },
  PASTE_CREATE_ANON: { limit: 10, windowSeconds: 3600 },
  PASTE_CREATE_USER: { limit: 60, windowSeconds: 3600 },
  PASTE_READ: { limit: 300, windowSeconds: 60 },
  RAW_DOWNLOAD: { limit: 120, windowSeconds: 60 },
  UNLOCK: { limit: 10, windowSeconds: 15 * 60 },
  FORK: { limit: 20, windowSeconds: 3600 },
  SEARCH: { limit: 60, windowSeconds: 60 },
  REPORTS: { limit: 10, windowSeconds: 3600 },
  ADMIN: { limit: 120, windowSeconds: 60 },
  PASSWORD_RESET: { limit: 5, windowSeconds: 3600 },
  VERIFY_EMAIL: { limit: 5, windowSeconds: 3600 },
  OAUTH: { limit: 30, windowSeconds: 900 },
} as const;

/** Anonymous paste-creation quota per IP per UTC day. */
export const ANON_DAILY_PASTE_QUOTA = 20;

/** API key daily request quota per key (Phase 5). */
export const API_DAILY_QUOTA = 1000;

/** View flush cadence and tolerance (docs/ARCHITECTURE.md §12.2). */
export const VIEW_FLUSH_INTERVAL_SECONDS = 60;
export const VIEW_COUNT_RECONCILE_TOLERANCE = 0.05;

// --- Phase 1: auth (docs/ARCHITECTURE.md §4 D) ------------------------------

/** Rolling idle expiry for sessions. */
export const SESSION_IDLE_DAYS = 30;
/** A session's lastUsedAt/expiresAt row is rewritten at most this often. */
export const SESSION_TOUCH_THRESHOLD_HOURS = 1;

export const EMAIL_VERIFICATION_TTL_HOURS = 24;
export const PASSWORD_RESET_TTL_HOURS = 1;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
/** Usernames are lowercased at the app layer before this pattern is applied. */
export const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

export const SESSION_COOKIE = '__Host-sess';
export const OAUTH_STATE_COOKIE = '__Host-oauth';
export const OAUTH_STATE_TTL_SECONDS = 600;
export const OAUTH_CALLBACK_PATH = '/api/v1/auth/oauth';

/** OAuth provider endpoints (docs/ARCHITECTURE.md §4 D). */
export const OAUTH_ENDPOINTS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  github: {
    auth: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    api: 'https://api.github.com',
  },
} as const;

/** Account deletion anonymization marker (docs/ARCHITECTURE.md §5.2). */
export function deletedEmailFor(userId: string): string {
  return `deleted+${userId}@invalid`;
}

// --- Phase 2: paste core (docs/ARCHITECTURE.md §4 A/B/C) ---------------------

/** ExpiresIn presets (seconds) — converted to absolute timestamps at creation. */
export const EXPIRES_IN_PRESETS_SECONDS = {
  '10min': 10 * 60,
  '1h': 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1m': 30 * 24 * 60 * 60,
} as const;

export type ExpiresInPreset = keyof typeof EXPIRES_IN_PRESETS_SECONDS;

export const PASTE_ID_COLLISION_RETRIES = 3;
export const LANGUAGE_PATTERN = /^[a-z0-9+#-]{1,30}$/;
export const SLUG_PATTERN = /^[a-z0-9_-]{3,64}$/;
export const PASTE_PASSWORD_MIN = 4;
export const PASTE_PASSWORD_MAX = 128;

/** Redis keyspace (docs/ARCHITECTURE.md §12.1). */
export const REDIS_KEYS = {
  anonQuota: (ip: string, date: string) => `quota:anon:${ip}:${date}`,
  viewDelta: (pasteId: string) => `views:delta:${pasteId}`,
  viewInflight: (pasteId: string, runId: string) => `views:inflight:${pasteId}:${runId}`,
  uv: (pasteId: string, date: string) => `uv:${pasteId}:${date}`,
  mgmtCache: (pasteId: string) => `mgmt:${pasteId}`,
} as const;

/** Management-token read-through cache TTL (DB hash remains authoritative). */
export const MGMT_CACHE_TTL_SECONDS = 900;

/** Anonymous management token: expires with the paste when it has a TTL. */
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
