# Pastebin Backend — Revised Architecture (Rev 2) & Implementation Readiness

## Context
Architecture approved subject to 8 corrections, all incorporated into Revision 2 (full revised sections delivered in conversation above): stable-predicate partial indexes with query-side expiry checks, anonymous management tokens hashed in a unified `paste_tokens` PostgreSQL table (Redis = optional read-through cache), atomic burn-after-read consumption via a single guarded UPDATE…RETURNING transaction, normative view-count buffering/flush/recovery spec (exactly-once, ≤60s loss on catastrophic Redis loss), normative OAuth spec (single-use state, PKCE S256, verified-email requirement, ordered linking rules), sweeper-authoritative BullMQ reconciliation with explicit Redis persistence/retry policies, Idempotency-Key support on paste creation, and per-phase migration slicing (Phase 0 ships an empty baseline; each phase migrates only its tables).

## Stack (unchanged)
Express 5 + TypeScript strict modular monolith; PostgreSQL 16 (source of truth, 17 tables); Redis 7 (ephemeral only); BullMQ workers; Prisma + Zod; Pino; Argon2id; custom DB sessions; Nginx + PM2 on a single VPS; Vitest suites incl. CI-enforced authorization matrix.

## Implementation roadmap (per-phase migrations)
- **Phase 0 — Foundation** (no business tables): scaffold, strict TS, Zod env validation, docker-compose (PG/Redis/MailHog), Pino + requestId + error envelope, health endpoints, CI (typecheck/lint/test), PM2 + Nginx deploy scripts.
- **Phase 1 — Auth & users**: users/sessions/oauth_accounts/auth_tokens migrations; register/login/logout, Argon2id, email verify/reset, Google+GitHub OAuth (state+PKCE+verified-email+linking), profiles, account deletion. Gate: OAuth tests green.
- **Phase 2 — Paste core**: pastes/paste_revisions/paste_tokens/paste_view_daily + partial-index migration; visibility policy, password/unlock, expiration (query filter + jobs + sweeper), atomic burn, max_views, anon management tokens, raw/download, forks, view buffering with crash recovery, anon quotas. Gate: burn concurrency + flush recovery + expiry-race tests green.
- **Phase 3 — Revisions**: cap 20, history, diff, restore (tables exist).
- **Phase 4 — Discovery**: feeds, keyset pagination, filters, title FTS (search_vector migration), public profiles. Gate: no unlisted/private leaks.
- **Phase 5 — Developer API**: api_keys/api_usage migrations; bearer keys, quotas, Idempotency-Key, OpenAPI/Swagger. Gate: idempotency + quota tests.
- **Phase 6 — Collections & bookmarks**; **Phase 7 — Analytics & embeds**; **Phase 8 — Abuse & admin** (abuse_reports/audit_logs/user_restrictions/ip_bans migrations); **Phase 9 — Hardening & launch**.
- MVP = Phases 0–5 + minimal admin.

## Files created at scaffold (Phase 0) and beyond
- `docs/ARCHITECTURE.md` (this blueprint, persisted), `prisma/schema.prisma` + per-phase migrations (incl. raw SQL for stable-predicate partial indexes and Phase-4 tsvector), `src/` tree per §14 (config, routes, controllers, services, repositories, middleware, validators, queues, workers, lib, types), `tests/` (unit/integration/api/workers/load), `deploy/` (nginx.conf, ecosystem.config.js, deploy.sh), `docker-compose.yml`, `.env.example`.

## Verification
- Each phase: unit/integration/API suites green in CI (docker-compose real PG+Redis).
- Key correctness tests: burn concurrency (exactly one consumer), flush crash recovery (no double-count), expiry race (404 before worker runs), idempotency replay/409/422, OAuth state/PKCE/linking, authorization matrix across all routes and viewer kinds.
- End-to-end: docker-compose dev stack — full paste lifecycle incl. expiring/burned/password-protected pastes, uniform-404 checks, revision diff/restore, API-key flow with idempotent retries.
- Phase 9 gate: security suite green, k6 load targets met, backup-restore drill completed.