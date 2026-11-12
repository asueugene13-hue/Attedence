-- CreateEnum
CREATE TYPE "AssistMethod" AS ENUM ('PHONE_UNAVAILABLE', 'NO_SMARTPHONE', 'BEACON_FAILURE', 'LATE_ENROLMENT', 'OTHER');

-- CreateTable
CREATE TABLE "assisted_check_ins" (
    "id" UUID NOT NULL,
    "attendance_session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "method" "AssistMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "performed_by_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assisted_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assisted_check_ins_attendance_session_id_idx" ON "assisted_check_ins"("attendance_session_id");

-- CreateIndex
CREATE INDEX "assisted_check_ins_student_id_idx" ON "assisted_check_ins"("student_id");

-- AddForeignKey
ALTER TABLE "assisted_check_ins" ADD CONSTRAINT "assisted_check_ins_attendance_session_id_fkey" FOREIGN KEY ("attendance_session_id") REFERENCES "attendance_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_check_ins" ADD CONSTRAINT "assisted_check_ins_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_check_ins" ADD CONSTRAINT "assisted_check_ins_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_check_ins" ADD CONSTRAINT "assisted_check_ins_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A hand check-in is part of the record's history: never changed or removed.
CREATE TRIGGER "assisted_check_ins_append_only"
  BEFORE UPDATE OR DELETE ON "assisted_check_ins"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
ALTER TABLE "assisted_check_ins" ADD CONSTRAINT "assisted_check_ins_reason"
  CHECK (length(trim("reason")) >= 5);
