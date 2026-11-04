import { z } from 'zod';

/**
 * Environment configuration — validated once at boot, fail-fast.
 * Every variable the app may consume must be declared here with a real
 * constraint so a misconfigured deploy dies at startup, not mid-request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Trusted reverse-proxy hops in front of the app (Nginx = 1).
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  // Browser origin allowed to call the API with cookies. Unset = CORS disabled.
  FRONTEND_ORIGIN: z.url().optional(),
  // Public base URL of this API (OAuth redirect URIs, email confirmation links).
  APP_BASE_URL: z.url().default('http://localhost:3000'),

  // --- Phase 1: auth ---
  // Future HMAC key (analytics visitor hashing); validated when present.
  SESSION_SECRET: z.string().min(32).optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('Paste <no-reply@localhost>'),

  // OAuth providers — endpoints return 503 until both values are configured.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  // CAPTCHA integration point (§4 J) — provider 'none' disables checks.
  CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
  CAPTCHA_SITE_KEY: z.string().optional(),
  CAPTCHA_SECRET_KEY: z.string().optional(),
  // Test hook: verify-endpoint override for the mock captcha provider.
  CAPTCHA_VERIFY_URL: z.string().optional(),
  // Test hook: JSON map overriding provider endpoints, e.g.
  // {"google":{"auth":"...","token":"...","userinfo":"..."},"github":{...}}
  OAUTH_ENDPOINTS_JSON: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Pure function so tests can exercise validation without process.env. */
export function buildEnv(raw: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${summary}`);
  }
  return parsed.data;
}

function bootEnv(): Env {
  try {
    return buildEnv(process.env);
  } catch (err) {
    // Fail fast and legibly — a misconfigured deploy must never half-start.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export const env: Env = bootEnv();

/** Parsed OAuth endpoint overrides (used by integration tests' mock servers). */
export const oauthEndpointOverrides: Record<
  string,
  Partial<Record<'auth' | 'token' | 'userinfo' | 'api', string>>
> = (() => {
  if (!env.OAUTH_ENDPOINTS_JSON) return {};
  try {
    const parsed: unknown = JSON.parse(env.OAUTH_ENDPOINTS_JSON);
    return parsed && typeof parsed === 'object' ? (parsed as typeof oauthEndpointOverrides) : {};
  } catch {
    console.error('OAUTH_ENDPOINTS_JSON is not valid JSON; ignoring');
    return {};
  }
})();
