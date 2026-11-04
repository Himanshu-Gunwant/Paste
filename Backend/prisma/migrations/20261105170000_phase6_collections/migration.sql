-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "description" VARCHAR(500),
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_pastes" (
    "collection_id" UUID NOT NULL,
    "paste_id" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_pastes_pkey" PRIMARY KEY ("collection_id","paste_id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "user_id" UUID NOT NULL,
    "paste_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("user_id","paste_id")
);

-- CreateIndex
CREATE INDEX "collections_visibility_created_at_idx" ON "collections"("visibility", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "collections_owner_id_slug_key" ON "collections"("owner_id", "slug");

-- CreateIndex
CREATE INDEX "collection_pastes_paste_id_idx" ON "collection_pastes"("paste_id");

-- CreateIndex
CREATE INDEX "bookmarks_paste_id_idx" ON "bookmarks"("paste_id");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_pastes" ADD CONSTRAINT "collection_pastes_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_pastes" ADD CONSTRAINT "collection_pastes_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

