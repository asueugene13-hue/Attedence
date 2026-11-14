-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('SUBMITTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DisputeMessageKind" AS ENUM ('QUESTION', 'REPLY');

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'REQUEST_ATTACHMENT';

-- CreateTable
CREATE TABLE "attendance_disputes" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'SUBMITTED',
    "record_status" "AttendanceStatus" NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "waiting_since" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "outcome" "AttendanceStatus",
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_messages" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "kind" "DisputeMessageKind" NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_attachments" (
    "dispute_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispute_attachments_pkey" PRIMARY KEY ("dispute_id","file_id")
);

-- CreateIndex
CREATE INDEX "attendance_disputes_student_id_submitted_at_idx" ON "attendance_disputes"("student_id", "submitted_at");

-- CreateIndex
CREATE INDEX "attendance_disputes_status_waiting_since_idx" ON "attendance_disputes"("status", "waiting_since");

-- CreateIndex
CREATE INDEX "attendance_disputes_record_id_idx" ON "attendance_disputes"("record_id");

-- CreateIndex
CREATE INDEX "dispute_messages_dispute_id_created_at_idx" ON "dispute_messages"("dispute_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_attachments_file_id_key" ON "dispute_attachments"("file_id");

-- AddForeignKey
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "attendance_disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "attendance_disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Only absent or rejected records are disputed, with an explanation.
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_disputable"
  CHECK ("record_status" IN ('ABSENT', 'REJECTED') AND length(trim("reason")) >= 10);
-- A decided dispute says who decided and when; an open one does not. Waiting for a reviewer has a start.
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_decided"
  CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_id" IS NULL)
     AND ("status" = 'APPROVED') = ("outcome" IS NOT NULL)
     AND ("status" <> 'REJECTED' OR length(trim("decision_note")) >= 5)
     AND ("status" <> 'SUBMITTED' OR "waiting_since" IS NOT NULL));
ALTER TABLE "attendance_disputes" ADD CONSTRAINT "attendance_disputes_outcome"
  CHECK ("outcome" IS NULL OR "outcome" IN ('PRESENT', 'LATE'));
-- At most one open dispute per record.
CREATE UNIQUE INDEX "attendance_disputes_one_open"
  ON "attendance_disputes" ("record_id") WHERE "status" IN ('SUBMITTED', 'INFO_REQUESTED');

-- The conversation and the attached files are history: never edited or removed by the application.
CREATE TRIGGER "dispute_messages_append_only" BEFORE UPDATE OR DELETE ON "dispute_messages"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
CREATE TRIGGER "dispute_attachments_append_only" BEFORE UPDATE OR DELETE ON "dispute_attachments"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
