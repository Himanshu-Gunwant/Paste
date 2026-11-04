# Operations Runbook — Paste Backend

Companion to `Backend/docs/ARCHITECTURE.md` (§16 monitoring, §17 deployment) and `DECISIONS.md`.

## 1. Deployment

```
CI (GitHub Actions: typecheck → lint → migrations → tests) → tag v1.x.y
→ on the VPS:  ./deploy/deploy.sh <tag>
   (git fetch tag → npm ci (postinstall: prisma generate) → build →
    prisma migrate deploy → pm2 reload ecosystem.config.cjs →
    /readyz gate ×30 → auto-rollback to previous ref on failure)
```

- PM2 processes: `paste-api` (fork ×2, ports 3000/3001), `paste-worker` (×1, 30 s kill_timeout).
- Nginx: TLS via certbot, `client_max_body_size 2m`, `X-Forwarded-For` OVERWRITTEN (single trusted hop), `/metrics` denied, Bull Board IP-allowlisted.
- Migrations: `prisma migrate deploy` under advisory lock; expand-then-contract; authored via `Backend/scripts/make-migration.cjs` when CI shells are non-TTY (D-003), then `migrate deploy`.

## 2. Backups & restore (drilled 2026-11-05 — PASSED, 18 tables restored)

- **Nightly:** cron `0 3 * * *` → `./deploy/backup.sh /var/backups/paste 30` → `pg_dump -Fc | gzip`, 30-day local retention, sync to S3 (STANDARD_IA) in production.
- **Restore procedure:**
  1. `gunzip -c paste_<stamp>.dump.gz | pg_restore -d <scratch_db> --no-owner`
  2. Verify counts (`pg_tables`, `users`, `pastes`) — automated by `./deploy/restore-drill.sh`.
  3. Point the app at the restored database (or swap roles); redeploy API + worker.
- **Drill cadence:** quarterly; `deploy/restore-drill.sh` must print `RESTORE DRILL PASSED`.
- RPO 24 h / RTO ~1 h (architecture §17). Redis holds only reconstructable state — after a Redis loss: restart worker (repeatables re-register), sweepers rebuild correctness, ≤ 60 s of view analytics lost (§12.2).

## 3. Health & alerts

| Signal | Check | Alert |
|---|---|---|
| App down | `/healthz` (PM2 restarts + UptimeRobot) | immediate |
| 5xx spike | Pino warn/error lines, Sentry | > 1% for 5 min |
| Disk | Netdata/node_exporter | > 80% |
| Queue backlog | Bull Board + `queue:failed` gauge | analytics backlog > 2 windows |
| DB | `pg_stat_statements`, connections | slow queries; conns > 80% |
| Redis | INFO memory/evictions | eviction > 0 (noeviction must hold) |

## 4. Secret rotation

| Secret | Where | Rotation |
|---|---|---|
| `SESSION_SECRET` | `.env` (chmod 600) | unused for sessions (random tokens); used as HMAC salt for visitor hashes — rotate → resets unique-visitor continuity |
| DB password | `.env`, `pg_hba.conf` | `ALTER USER paste WITH PASSWORD …` → update `.env` → `pm2 reload all` |
| Redis password | `.env`, redis.conf | rotate + rolling reload |
| OAuth client secrets | provider consoles + `.env` | console rotate → `.env` → reload |
| API keys | user-owned | revoke + re-create (hashed at rest, nothing to rotate server-side) |

No secret ever appears in logs (Pino redaction: authorization/cookie/x-paste-password headers, password/token/apiKey fields).

## 5. Incident basics

- **Abuse wave:** raise anon quotas (`constants.ts` → redeploy) or ban via `POST /admin/ip-bans`; reports auto-unlist at 3 OPEN.
- **Compromised API key:** revoke (`DELETE /api-keys/{id}`); usage visible in `api_usage` + `GET /users/me/api-usage`.
- **Bad release:** `deploy.sh` auto-rolls back on failed `/readyz` gate; manual: `git checkout <prev-tag> && npm ci && npm run build && pm2 reload deploy/ecosystem.config.cjs`.
- **Expiry leak suspicion:** the read-path SQL filter is authoritative — verify with `SELECT count(*) FROM pastes WHERE expires_at <= now() AND deleted_at IS NULL;` (must be 0 within 5 min of the sweeper).

## 6. Load testing

`npm run load:smoke` (k6 ≥ 0.49 installed separately) — 20 VUs × 30 s, thresholds p95 < 150 ms and check-rate > 99% on the feed/search/create mix. Scale trigger table lives in ARCHITECTURE.md §18.
