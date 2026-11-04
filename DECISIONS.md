# Architecture Decision Records — Paste backend

Supplements `Backend/docs/ARCHITECTURE.md` (the approved blueprint). Format: lightweight ADRs.

---

## D-002: Upgrade to Prisma 7 with driver adapters

**Date:** 2026-11-05 · **Status:** Accepted · **Decided by:** repository owner (explicit instruction)

**Context.** Prisma CLI 6.x carried a **high-severity** transitive advisory: `deepmerge-ts` stack exhaustion (GHSA-ggr8-5vv4-36mx) via `@prisma/config`. Prisma 7 (stable, 7.10.1) ships the new `prisma-client` generator, driver adapters, and `prisma.config.ts`. Phase 1 — where the first real model family had just landed — was the cheapest migration point.

**Decision.**
- Upgrade `prisma` + `@prisma/client` together to **7.10.1** (latest stable; Prisma 8 RCs explicitly rejected).
- Use the `prisma-client` generator with explicit output `src/generated/prisma` (TypeScript ESM; gitignored; `postinstall`/CI regenerate).
- Introduce `prisma.config.ts`; move the connection URL out of the schema (`datasource.url` is removed in Prisma 7) into config (CLI) and the runtime adapter.
- Configure the PostgreSQL driver adapter: `@prisma/adapter-pg` + `pg` in `src/lib/prisma.ts`; queries compile via the query compiler — no native engine binary.

**Consequences.** Generated TypeScript compiles with the app (`rootDir` unchanged; client lands in `dist/generated/prisma`). CLI and runtime connection sources are now separate but explicit. Future phases use `prisma migrate dev` unchanged (CLI reads `prisma.config.ts`).

**Security verification (inspected, not assumed).** After the upgrade:
| Item | Result |
|---|---|
| `npm ls deepmerge-ts` | absent from tree — high advisory **resolved** |
| `npm audit` | 10 → 7 advisories; zero high/critical; zero runtime-dependency advisories |
| Remaining 7 moderate | all in dev-only `typescript-eslint` → `minimatch@10` chain |

**Accepted residual risk:** the 7 moderate dev-tooling advisories. No in-range fix exists (the suggested "fix" downgrades `typescript-eslint` 8.44 → 8.36); lint tooling never ships to production. Revisit on the next `typescript-eslint` minor that drops the vulnerable `minimatch` range. This was verified rather than assumed — the major upgrade did **not** fix every transitive advisory, as anticipated.

**Alternatives considered.** (a) Stay on Prisma 6 — keeps a high dev-tooling advisory and defers migration cost into a codebase that grows every phase; rejected. (b) Prisma 8 RC — unstable; rejected per directive.

---

## D-001: Approved architecture (Revision 2)

**Date:** 2026-11-04 · **Status:** Accepted

Modular monolith on Express 5 + TypeScript strict; PostgreSQL 16 as source of truth; Redis 7 strictly ephemeral (rate limits, view buffers, queues) with sweeper-authoritative expiration/reconciliation; Argon2id passwords; hashed one-time credentials (`paste_tokens` PostgreSQL-authoritative); service-layer-only authorization; per-phase migration slicing. Full record: `Backend/docs/ARCHITECTURE.md`. Phase gates and roadmap in §19.
