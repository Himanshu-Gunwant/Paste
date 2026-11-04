-- NOTE: search_vector is a GENERATED column — Prisma diff emits a harmless
-- but invalid DROP DEFAULT for it; removed (no default exists).

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" BIGSERIAL NOT NULL,
    "api_key_id" UUID,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(120) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_usage_api_key_id_created_at_idx" ON "api_usage"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "api_usage_user_id_created_at_idx" ON "api_usage"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "api_usage_created_at_idx" ON "api_usage"("created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

