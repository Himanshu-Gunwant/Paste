import path from 'node:path';
import { defineConfig } from 'prisma/config';
import 'dotenv/config';

/**
 * Prisma 7 CLI configuration.
 * Prisma 7 no longer auto-loads .env — dotenv above provides it. The
 * datasource block is only included when DATABASE_URL is present so
 * environment-free commands (validate/generate) still work.
 *
 * SHADOW_DATABASE_URL is required only for `migrate diff --from-migrations`
 * (authoring migrations in non-TTY environments, DECISIONS.md D-003).
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  ...(process.env.DATABASE_URL
    ? {
        datasource: {
          url: process.env.DATABASE_URL,
          ...(process.env.SHADOW_DATABASE_URL
            ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
            : {}),
        },
      }
    : {}),
});
