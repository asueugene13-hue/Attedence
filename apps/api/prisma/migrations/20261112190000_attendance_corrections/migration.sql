-- CreateEnum
CREATE TYPE "CorrectionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "attendance_sessions" ADD COLUMN     "undecided_escalated_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "attendance_correction_requests" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "from_status" "AttendanceStatus" NOT NULL,
    "to_status" "AttendanceStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "record_version" INTEGER NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "CorrectionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "attendance_correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_correction_requests_status_requested_at_idx" ON "attendance_correction_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_record_id_idx" ON "attendance_correction_requests"("record_id");

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A request is decided once; a decided request says who decided and when.
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_decided"
  CHECK (("status" = 'PENDING') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by_id" IS NULL));
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_change"
  CHECK ("from_status" <> "to_status" AND length(trim("reason")) >= 5);
-- At most one waiting request per record.
CREATE UNIQUE INDEX "attendance_correction_requests_one_pending"
  ON "attendance_correction_requests" ("record_id") WHERE "status" = 'PENDING';
