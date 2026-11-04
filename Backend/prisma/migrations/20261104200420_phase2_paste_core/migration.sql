-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "DeletedBy" AS ENUM ('USER', 'MODERATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('MANAGEMENT', 'SHARE');

-- CreateTable
CREATE TABLE "pastes" (
    "id" VARCHAR(12) NOT NULL,
    "author_id" UUID,
    "custom_slug" VARCHAR(64),
    "title" VARCHAR(140),
    "description" VARCHAR(500),
    "language" VARCHAR(50),
    "detected_language" VARCHAR(50),
    "content" TEXT,
    "content_size" INTEGER NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC',
    "password_hash" TEXT,
    "max_views" INTEGER,
    "view_count" BIGINT NOT NULL DEFAULT 0,
    "burn_after_read" BOOLEAN NOT NULL DEFAULT false,
    "burned_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" "DeletedBy",
    "fork_of_id" VARCHAR(12),
    "latest_revision_no" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pastes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paste_revisions" (
    "id" UUID NOT NULL,
    "paste_id" VARCHAR(12) NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "title" VARCHAR(140),
    "description" VARCHAR(500),
    "language" VARCHAR(50),
    "content" TEXT NOT NULL,
    "content_size" INTEGER NOT NULL,
    "editor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paste_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paste_view_daily" (
    "paste_id" VARCHAR(12) NOT NULL,
    "day" DATE NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "unique_visitors" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "paste_view_daily_pkey" PRIMARY KEY ("paste_id","day")
);

-- CreateTable
CREATE TABLE "paste_tokens" (
    "id" UUID NOT NULL,
    "paste_id" VARCHAR(12) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "created_by" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paste_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pastes_author_id_created_at_idx" ON "pastes"("author_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pastes_visibility_language_created_at_idx" ON "pastes"("visibility", "language", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pastes_content_hash_idx" ON "pastes"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "paste_revisions_paste_id_revision_no_key" ON "paste_revisions"("paste_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "paste_tokens_token_hash_key" ON "paste_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "paste_tokens_paste_id_purpose_idx" ON "paste_tokens"("paste_id", "purpose");

-- AddForeignKey
ALTER TABLE "pastes" ADD CONSTRAINT "pastes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pastes" ADD CONSTRAINT "pastes_fork_of_id_fkey" FOREIGN KEY ("fork_of_id") REFERENCES "pastes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paste_revisions" ADD CONSTRAINT "paste_revisions_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paste_view_daily" ADD CONSTRAINT "paste_view_daily_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paste_tokens" ADD CONSTRAINT "paste_tokens_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paste_tokens" ADD CONSTRAINT "paste_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
