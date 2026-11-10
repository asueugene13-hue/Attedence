-- CreateEnum
CREATE TYPE "RiskType" AS ENUM ('SHARED_DEVICE', 'DEVICE_SWITCH', 'ACCOUNT_SWITCH', 'BEACON_LOCATION_CONFLICT', 'MOCK_LOCATION', 'INTEGRITY_FAILED', 'REPEATED_REJECTIONS', 'UNEXPECTED_BEACON');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'DISMISSED', 'CONFIRMED');

-- AlterTable
ALTER TABLE "user_devices" DROP COLUMN "credential_hash",
ADD COLUMN     "public_key" TEXT,
ADD COLUMN     "trust_request_reason" TEXT,
ADD COLUMN     "trust_requested_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "risk_flags" (
    "id" UUID NOT NULL,
    "type" "RiskType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "student_id" UUID,
    "device_id" UUID,
    "evidence" JSONB NOT NULL,
    "dedupe_key" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_flags_status_created_at_idx" ON "risk_flags"("status", "created_at");

-- CreateIndex
CREATE INDEX "risk_flags_student_id_created_at_idx" ON "risk_flags"("student_id", "created_at");

-- AddForeignKey
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- One student has at most one attendance phone at a time (D-10).
CREATE UNIQUE INDEX "user_devices_one_attendance_device" ON "user_devices" ("user_id") WHERE "is_attendance_device" AND "status" = 'TRUSTED';
-- A public key is 32 bytes, written base64url (43 characters).
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_public_key_format" CHECK ("public_key" IS NULL OR "public_key" ~ '^[A-Za-z0-9_-]{43}$');
-- The same situation is flagged once while the flag is open.
CREATE UNIQUE INDEX "risk_flags_one_open_per_key" ON "risk_flags" ("dedupe_key") WHERE "status" = 'OPEN' AND "dedupe_key" IS NOT NULL;
-- A reviewed flag says who, when and why; an open one has none of these.
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_review_complete"
  CHECK (("status" = 'OPEN') = ("reviewed_at" IS NULL)
     AND ("reviewed_at" IS NULL) = ("reviewed_by_id" IS NULL)
     AND ("reviewed_at" IS NULL) = ("review_note" IS NULL));
