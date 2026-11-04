# Paste — Pastebin Platform Backend

Production-grade Pastebin alternative backend: modular monolith on **Express 5 + TypeScript strict**, **PostgreSQL 16** (Prisma 7 driver adapters), **Redis 7 + BullMQ**, PM2/Nginx on a single VPS.

- Architecture (approved, Rev 2): [`Backend/docs/ARCHITECTURE.md`](Backend/docs/ARCHITECTURE.md)
- Operations runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Decisions: [`DECISIONS.md`](DECISIONS.md) · Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## Feature set (all shipped)

Auth (sessions, Argon2id, email verification, password reset, Google/GitHub OAuth with state+PKCE) · Pastes (visibility matrix, passwords, expiration, burn-after-read with atomic consumption, max_views, forks, raw/download, custom slugs) · Snapshot revisions (history/diff/restore) · Discovery (latest/popular/trending, FTS search, language facets, keyset pagination) · Developer API (hashed `pb_` keys, daily quotas, usage capture, idempotency keys, OpenAPI 3.1 + Swagger UI) · Collections & bookmarks · Analytics (buffered counters, HLL uniques, daily aggregates) · Embeds (server-rendered, strict CSP) · Abuse & admin (reports with auto-unlist, moderation, suspensions, audit trail, IP bans, CAPTCHA point).

## Quick start (dev)

```bash
cd Backend
npm install            # postinstall runs prisma generate
docker compose up -d   # postgres + redis (AOF/noeviction) + mailhog
cp .env.example .env   # fill secrets; dev defaults exist in docker-compose
npm run db:migrate:dev # apply migrations
npm run dev            # API on :3000  (worker: npm run dev:worker)
npm test               # unit suite (no services needed)
npm run test:integration  # 92+ tests against the docker stack (RUN_INTEGRATION=1)
```

Swagger UI: `http://localhost:3000/api/docs` · Health: `/healthz`, `/readyz`.

## Layout

```
Backend/src/          config · routes · controllers · services · repositories ·
                      middleware · validators · queues · workers · lib · plugins
Backend/prisma/       schema.prisma + per-phase migrations (raw SQL for partial
                      indexes + tsvector — stable predicates only)
Backend/tests/        unit · integration · load (k6)
Backend/deploy/       nginx.conf · PM2 ecosystem · backup.sh · restore-drill.sh · deploy.sh
docs/                 OPERATIONS.md runbook
```

## Production

Single VPS: Nginx (TLS, real_ip, body limits) → PM2 API ×2 + worker ×1 → local PostgreSQL + Redis (AOF, noeviction). Nightly `pg_dump` to S3 with quarterly restore drills. CI in `.github/workflows/ci.yml`. See `docs/OPERATIONS.md` for deploy, alerts, rotation, incidents.
