-- Phase 4: title/description full-text search (docs/ARCHITECTURE.md §4 G).
-- Generated column + partial GIN (stable predicate: visibility = 'PUBLIC').
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "pastes" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  to_tsvector('english', coalesce("title", '') || ' ' || coalesce("description", ''))
) STORED;

CREATE INDEX "pastes_search_gin_idx" ON "pastes" USING GIN ("search_vector") WHERE visibility = 'PUBLIC';
