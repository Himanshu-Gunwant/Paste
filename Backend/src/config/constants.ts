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
} as const;

/** Anonymous paste-creation quota per IP per UTC day. */
export const ANON_DAILY_PASTE_QUOTA = 20;

/** API key daily request quota per key (Phase 5). */
export const API_DAILY_QUOTA = 1000;

/** View flush cadence and tolerance (docs/ARCHITECTURE.md §12.2). */
export const VIEW_FLUSH_INTERVAL_SECONDS = 60;
export const VIEW_COUNT_RECONCILE_TOLERANCE = 0.05;
