-- CreateEnum
CREATE TYPE "ExcuseCategory" AS ENUM ('MEDICAL', 'BEREAVEMENT', 'OFFICIAL_UNIVERSITY_DUTY', 'OTHER');

-- CreateEnum
CREATE TYPE "ExcuseStatus" AS ENUM ('SUBMITTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "excuse_requests" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "category" "ExcuseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "ExcuseStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "excuse_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excuse_request_classes" (
    "excuse_request_id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "included" BOOLEAN,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "excuse_request_classes_pkey" PRIMARY KEY ("excuse_request_id","class_session_id")
);

-- CreateTable
CREATE TABLE "excuse_messages" (
    "id" UUID NOT NULL,
    "excuse_request_id" UUID NOT NULL,
    "kind" "DisputeMessageKind" NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "excuse_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excuse_attachments" (
    "excuse_request_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "excuse_attachments_pkey" PRIMARY KEY ("excuse_request_id","file_id")
);

-- CreateIndex
CREATE INDEX "excuse_requests_student_id_submitted_at_idx" ON "excuse_requests"("student_id", "submitted_at");

-- CreateIndex
CREATE INDEX "excuse_requests_status_submitted_at_idx" ON "excuse_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "excuse_request_classes_class_session_id_idx" ON "excuse_request_classes"("class_session_id");

-- CreateIndex
CREATE INDEX "excuse_messages_excuse_request_id_created_at_idx" ON "excuse_messages"("excuse_request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "excuse_attachments_file_id_key" ON "excuse_attachments"("file_id");

-- AddForeignKey
ALTER TABLE "excuse_requests" ADD CONSTRAINT "excuse_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_requests" ADD CONSTRAINT "excuse_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_request_classes" ADD CONSTRAINT "excuse_request_classes_excuse_request_id_fkey" FOREIGN KEY ("excuse_request_id") REFERENCES "excuse_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_request_classes" ADD CONSTRAINT "excuse_request_classes_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_messages" ADD CONSTRAINT "excuse_messages_excuse_request_id_fkey" FOREIGN KEY ("excuse_request_id") REFERENCES "excuse_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_messages" ADD CONSTRAINT "excuse_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_attachments" ADD CONSTRAINT "excuse_attachments_excuse_request_id_fkey" FOREIGN KEY ("excuse_request_id") REFERENCES "excuse_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excuse_attachments" ADD CONSTRAINT "excuse_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- A request has an explanation and dates in order; a decided one says who and when; rejecting needs a note.
ALTER TABLE "excuse_requests" ADD CONSTRAINT "excuse_requests_valid"
  CHECK (length(trim("description")) >= 10 AND "end_date" >= "start_date" AND "end_date" - "start_date" < 31);
ALTER TABLE "excuse_requests" ADD CONSTRAINT "excuse_requests_decided"
  CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_id" IS NULL)
     AND ("status" <> 'REJECTED' OR length(trim("decision_note")) >= 5));
-- Only an included class is ever applied.
ALTER TABLE "excuse_request_classes" ADD CONSTRAINT "excuse_request_classes_applied"
  CHECK ("applied_at" IS NULL OR "included" IS TRUE);

-- The conversation and the files are history.
CREATE TRIGGER "excuse_messages_append_only" BEFORE UPDATE OR DELETE ON "excuse_messages"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
CREATE TRIGGER "excuse_attachments_append_only" BEFORE UPDATE OR DELETE ON "excuse_attachments"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
