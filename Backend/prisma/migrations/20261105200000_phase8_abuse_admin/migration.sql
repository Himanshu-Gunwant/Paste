-- CreateEnum
CREATE TYPE "AbuseReason" AS ENUM ('SPAM', 'MALWARE', 'HARASSMENT', 'COPYRIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "RestrictionType" AS ENUM ('SUSPENSION', 'UPLOAD_BAN');

-- CreateTable
CREATE TABLE "abuse_reports" (
    "id" UUID NOT NULL,
    "paste_id" VARCHAR(64) NOT NULL,
    "reporter_id" UUID,
    "reporter_ip_hash" VARCHAR(64) NOT NULL,
    "reason" "AbuseReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "handled_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "abuse_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(30),
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(40),
    "target_id" VARCHAR(64),
    "metadata" JSONB,
    "ip_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_restrictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "RestrictionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "lifted_at" TIMESTAMPTZ(6),
    "lifted_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_bans" (
    "id" UUID NOT NULL,
    "ip_hash" VARCHAR(64) NOT NULL,
    "subnet_hash" VARCHAR(64),
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_bans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "abuse_reports_status_created_at_idx" ON "abuse_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "abuse_reports_paste_id_idx" ON "abuse_reports"("paste_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "user_restrictions_user_id_type_idx" ON "user_restrictions"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ip_bans_ip_hash_key" ON "ip_bans"("ip_hash");

-- AddForeignKey
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_paste_id_fkey" FOREIGN KEY ("paste_id") REFERENCES "pastes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_handled_by_fkey" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_lifted_by_fkey" FOREIGN KEY ("lifted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_bans" ADD CONSTRAINT "ip_bans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

