/* Migration authoring helper for non-TTY environments (D-003).
 * Usage: node scripts/make-migration.cjs <timestamp_name>
 * Requires docker postgres running (shadow DB) and the schema updated.
 * Strips Prisma's invalid generated-column artifact automatically. */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/make-migration.cjs <timestamp_name>');
  process.exit(1);
}

const SHADOW = 'postgresql://paste:paste_dev_password@localhost:5432/shadow_tmp';
const psql = (sql) => execSync(`docker exec backend-postgres-1 psql -U paste -d paste -c "${sql}"`, { stdio: 'pipe' });

psql('DROP DATABASE IF EXISTS shadow_tmp;');
psql('CREATE DATABASE shadow_tmp;');

let sql;
try {
  sql = execSync(
    `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`,
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SHADOW_DATABASE_URL: SHADOW },
    },
  ).toString();
} finally {
  psql('DROP DATABASE IF EXISTS shadow_tmp;');
}

sql = sql.replace(
  /-- AlterTable\nALTER TABLE "pastes" ALTER COLUMN "search_vector" DROP DEFAULT;\n\n?/,
  '',
);
if (/search_vector.*DROP DEFAULT/.test(sql)) {
  console.error('unexpected search_vector artifact remains');
  process.exit(1);
}
if (sql.trim().length === 0) {
  console.error('diff is empty — schema and migrations already in sync');
  process.exit(1);
}

const dir = path.join('prisma', 'migrations', name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
console.log(`written ${dir}/migration.sql (${sql.length} bytes)`);
console.log('now: reset any failed record, then `npx prisma migrate deploy`');
