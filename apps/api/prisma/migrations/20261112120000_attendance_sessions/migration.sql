-- CreateEnum
CREATE TYPE "AttendanceSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttendanceCloseReason" AS ENUM ('MANUAL', 'AUTO', 'CLASS_ENDED', 'CLASS_VOIDED', 'FORCED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'PENDING', 'UNDER_REVIEW', 'REJECTED', 'ABSENT', 'EXCUSED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('CHECK_IN', 'ASSISTED', 'CLOSE');

-- CreateEnum
CREATE TYPE "CorrectionSource" AS ENUM ('LECTURER', 'ADMINISTRATOR', 'REVIEW', 'DISPUTE', 'EXCUSE', 'VOID');

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "status" "AttendanceSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_by_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "late_after" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "close_reason" "AttendanceCloseReason",
    "reopened_at" TIMESTAMPTZ(3),
    "qr_secret_enc" TEXT NOT NULL,
    "qr_rotation_seconds" INTEGER NOT NULL,
    "verification_policy_version" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "attendance_session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "source" "RecordSource" NOT NULL,
    "checked_in_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "from_status" "AttendanceStatus" NOT NULL,
    "to_status" "AttendanceStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "CorrectionSource" NOT NULL,
    "source_id" UUID,
    "corrected_by_id" UUID,
    "corrected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_class_session_id_key" ON "attendance_sessions"("class_session_id");

-- CreateIndex
CREATE INDEX "attendance_sessions_status_closes_at_idx" ON "attendance_sessions"("status", "closes_at");

-- CreateIndex
CREATE INDEX "attendance_records_student_id_status_idx" ON "attendance_records"("student_id", "status");

-- CreateIndex
CREATE INDEX "attendance_records_attendance_session_id_status_idx" ON "attendance_records"("attendance_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_class_session_id_student_id_key" ON "attendance_records"("class_session_id", "student_id");

-- CreateIndex
CREATE INDEX "attendance_corrections_record_id_corrected_at_idx" ON "attendance_corrections"("record_id", "corrected_at");

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_attendance_session_id_fkey" FOREIGN KEY ("attendance_session_id") REFERENCES "attendance_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_corrected_by_id_fkey" FOREIGN KEY ("corrected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Corrections are the history of a record: never changed or removed.
CREATE TRIGGER "attendance_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
-- Records are never deleted (a mistaken record is corrected, with a reason).
CREATE OR REPLACE FUNCTION "block_attendance_record_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attendance records are never deleted; correct them with a reason';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "attendance_records_no_delete"
  BEFORE DELETE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "block_attendance_record_delete"();
-- Consistent session times and closing.
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_times"
  CHECK ("late_after" >= "opened_at" AND "closes_at" > "opened_at");
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_closed_complete"
  CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL AND "close_reason" IS NOT NULL));
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_rotation"
  CHECK ("qr_rotation_seconds" BETWEEN 10 AND 30);
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_changes"
  CHECK ("from_status" <> "to_status" AND length(trim("reason")) >= 5);
