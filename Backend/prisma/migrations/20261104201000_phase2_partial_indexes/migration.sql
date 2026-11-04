-- Partial indexes with STABLE predicates only — volatile expressions such as
-- now() are prohibited in index predicates; expiry filtering happens
-- exclusively in query WHERE clauses (docs/ARCHITECTURE.md §5.3).

-- Global custom-slug namespace (partial: plain NULLs never conflict).
CREATE UNIQUE INDEX pastes_custom_slug_uidx ON pastes (custom_slug) WHERE custom_slug IS NOT NULL;

-- Public discovery feed (Phase 4 consumers; harmless to create early).
CREATE INDEX pastes_visibility_created_idx ON pastes (visibility, created_at DESC) WHERE deleted_at IS NULL;

-- Expiry sweeper scan.
CREATE INDEX pastes_expires_idx ON pastes (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Purge sweep scan.
CREATE INDEX pastes_deleted_idx ON pastes (deleted_at) WHERE deleted_at IS NOT NULL;
