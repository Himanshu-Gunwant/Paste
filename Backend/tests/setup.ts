import 'dotenv/config';

// Test bootstrap: DATABASE_URL/REDIS_URL come from .env when present (needed
// by integration tests); NODE_ENV and LOG_LEVEL are forced for determinism so
// a developer's .env cannot change test behavior or flood the output.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??=
  'postgresql://paste:paste_dev_password@localhost:5432/paste?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
