-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('LECTURER_NOT_ARRIVED', 'VERBAL_CANCELLATION', 'CLASS_DELAYED', 'WRONG_CLASSROOM', 'VENUE_PROBLEM', 'TIMETABLE_ERROR', 'TECHNICAL_PROBLEM', 'OTHER');

-- CreateEnum
CREATE TYPE "ReporterRole" AS ENUM ('STUDENT', 'COURSE_REP', 'LECTURER');

-- CreateEnum
CREATE TYPE "IssueReportStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReviewTrigger" AS ENUM ('SYSTEM_ESCALATION', 'ADMIN_OPENED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'DECIDED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('CLASS_HELD', 'CANCELLED', 'POSTPONED', 'RESCHEDULED', 'NO_ACTION');

-- CreateTable
CREATE TABLE "class_issue_reports" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "reporter_role" "ReporterRole" NOT NULL,
    "type" "IssueType" NOT NULL,
    "note" TEXT,
    "status" "IssueReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_issue_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_status_reviews" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "trigger" "ReviewTrigger" NOT NULL,
    "is_priority" BOOLEAN NOT NULL DEFAULT false,
    "reasons" JSONB NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "decision" "ReviewDecision",
    "decision_note" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "class_status_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "class_issue_reports_class_session_id_created_at_idx" ON "class_issue_reports"("class_session_id", "created_at");

-- CreateIndex
CREATE INDEX "class_issue_reports_reporter_user_id_created_at_idx" ON "class_issue_reports"("reporter_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "class_issue_reports_class_session_id_reporter_user_id_type_key" ON "class_issue_reports"("class_session_id", "reporter_user_id", "type");

-- CreateIndex
CREATE INDEX "class_status_reviews_status_is_priority_opened_at_idx" ON "class_status_reviews"("status", "is_priority", "opened_at");

-- CreateIndex
CREATE INDEX "class_status_reviews_class_session_id_idx" ON "class_status_reviews"("class_session_id");

-- AddForeignKey
ALTER TABLE "class_issue_reports" ADD CONSTRAINT "class_issue_reports_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_issue_reports" ADD CONSTRAINT "class_issue_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_status_reviews" ADD CONSTRAINT "class_status_reviews_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_status_reviews" ADD CONSTRAINT "class_status_reviews_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- At most one open review per class.
CREATE UNIQUE INDEX "class_status_reviews_one_open" ON "class_status_reviews" ("class_session_id") WHERE "status" = 'OPEN';
-- A decided review says what was decided, by whom, when and why; an open one has none of these.
ALTER TABLE "class_status_reviews" ADD CONSTRAINT "class_status_reviews_decision_complete"
  CHECK (("status" = 'OPEN') = ("decision" IS NULL)
     AND ("decision" IS NULL) = ("decided_at" IS NULL)
     AND ("decision" IS NULL) = ("decision_note" IS NULL));
-- Report notes are short plain text.
ALTER TABLE "class_issue_reports" ADD CONSTRAINT "class_issue_reports_note_length" CHECK (char_length("note") <= 500);
