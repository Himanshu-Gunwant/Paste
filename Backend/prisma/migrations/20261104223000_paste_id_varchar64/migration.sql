-- Widen paste id columns: custom slugs (up to 64 chars) serve as the id itself.
-- Children first, then the referenced parent column (PG rebuilds FKs implicitly).
ALTER TABLE "paste_revisions" ALTER COLUMN "paste_id" SET DATA TYPE VARCHAR(64);
ALTER TABLE "paste_view_daily" ALTER COLUMN "paste_id" SET DATA TYPE VARCHAR(64);
ALTER TABLE "paste_tokens" ALTER COLUMN "paste_id" SET DATA TYPE VARCHAR(64);
ALTER TABLE "pastes" ALTER COLUMN "fork_of_id" SET DATA TYPE VARCHAR(64);
ALTER TABLE "pastes" ALTER COLUMN "id" SET DATA TYPE VARCHAR(64);
