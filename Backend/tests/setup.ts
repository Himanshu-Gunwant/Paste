import 'dotenv/config';

// Test bootstrap: DATABASE_URL/REDIS_URL come from .env when present (needed
// by integration tests); NODE_ENV and LOG_LEVEL are forced for determinism so
// a developer's .env cannot change test behavior or flood the output.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??=
  'postgresql://paste:paste_dev_password@localhost:5432/paste?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';

// Integration fixtures: MailHog SMTP, a fixed-port OAuth mock provider, and
// dummy OAuth credentials. The mock endpoints must match tests/helpers/mock-oauth.ts.
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.SMTP_HOST ??= '127.0.0.1';
process.env.SMTP_PORT ??= '1025';
process.env.GOOGLE_CLIENT_ID ??= 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-secret';
process.env.GITHUB_CLIENT_ID ??= 'test-github-client';
process.env.GITHUB_CLIENT_SECRET ??= 'test-github-secret';
process.env.OAUTH_ENDPOINTS_JSON ??= JSON.stringify({
  google: {
    auth: 'http://127.0.0.1:18888/google/auth',
    token: 'http://127.0.0.1:18888/google/token',
    userinfo: 'http://127.0.0.1:18888/google/userinfo',
  },
  github: {
    auth: 'http://127.0.0.1:18888/github/auth',
    token: 'http://127.0.0.1:18888/github/token',
    api: 'http://127.0.0.1:18888/github/api',
  },
});
