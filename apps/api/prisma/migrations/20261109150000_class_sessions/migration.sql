-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('REGULAR', 'MAKEUP', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED', 'UNDER_REVIEW', 'ACTIVE', 'INTERRUPTED', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ClassEventType" AS ENUM ('GENERATED', 'UPDATED', 'VENUE_CHANGED', 'REMINDER_SENT', 'CONFIRMED', 'STARTED', 'DELAY_REPORTED', 'MARKED_UNCONFIRMED', 'LECTURER_PROMPTED', 'ISSUE_REPORTED', 'ESCALATED', 'REVIEW_DECIDED', 'CANCELLED', 'RESCHEDULED', 'SUSPENDED', 'RESUMED', 'INTERRUPTED', 'ENDED', 'AUTO_ENDED', 'ATTENDANCE_OPENED', 'ATTENDANCE_CLOSED', 'ATTENDANCE_REOPENED', 'ATTENDANCE_VOIDED', 'REINSTATED');

-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('LECTURER_UNAVAILABLE', 'ILLNESS', 'OFFICIAL_DUTY', 'VENUE_UNAVAILABLE', 'INSTITUTION_EVENT', 'PUBLIC_HOLIDAY', 'EMERGENCY', 'LECTURER_ABSENT_NO_NOTICE', 'OTHER');

-- AlterTable
ALTER TABLE "timetable_entries" ADD COLUMN     "source_entry_id" UUID;

-- AlterTable
ALTER TABLE "timetables" ADD COLUMN     "sessions_generated_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "class_sessions" (
    "id" UUID NOT NULL,
    "timetable_entry_id" UUID,
    "kind" "SessionKind" NOT NULL DEFAULT 'REGULAR',
    "lecturer_id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(3) NOT NULL,
    "expected_start" TIMESTAMPTZ(3),
    "actual_start" TIMESTAMPTZ(3),
    "actual_end" TIMESTAMPTZ(3),
    "status" "ClassStatus" NOT NULL DEFAULT 'SCHEDULED',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancel_reason" "CancelReason",
    "cancel_note" TEXT,
    "cancelled_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_session_sections" (
    "class_session_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,

    CONSTRAINT "class_session_sections_pkey" PRIMARY KEY ("class_session_id","section_id")
);

-- CreateTable
CREATE TABLE "class_events" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "type" "ClassEventType" NOT NULL,
    "from_status" "ClassStatus",
    "to_status" "ClassStatus",
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "class_sessions_status_scheduled_start_idx" ON "class_sessions"("status", "scheduled_start");

-- CreateIndex
CREATE INDEX "class_sessions_lecturer_id_scheduled_start_idx" ON "class_sessions"("lecturer_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "class_sessions_classroom_id_scheduled_start_idx" ON "class_sessions"("classroom_id", "scheduled_start");

-- CreateIndex
CREATE UNIQUE INDEX "class_sessions_timetable_entry_id_scheduled_start_key" ON "class_sessions"("timetable_entry_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "class_session_sections_section_id_idx" ON "class_session_sections"("section_id");

-- CreateIndex
CREATE INDEX "class_events_class_session_id_occurred_at_idx" ON "class_events"("class_session_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_timetable_entry_id_fkey" FOREIGN KEY ("timetable_entry_id") REFERENCES "timetable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_sections" ADD CONSTRAINT "class_session_sections_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_sections" ADD CONSTRAINT "class_session_sections_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_events" ADD CONSTRAINT "class_events_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_events" ADD CONSTRAINT "class_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- No room holds two live sessions at once, and no lecturer teaches two at once. Deferrable, so a
-- regeneration that moves several sessions in one transaction is checked as a whole at commit.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_room_no_overlap"
  EXCLUDE USING gist ("classroom_id" WITH =, tstzrange("scheduled_start", "scheduled_end", '[)') WITH &&)
  WHERE ("status" NOT IN ('CANCELLED', 'RESCHEDULED'))
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_lecturer_no_overlap"
  EXCLUDE USING gist ("lecturer_id" WITH =, tstzrange("scheduled_start", "scheduled_end", '[)') WITH &&)
  WHERE ("status" NOT IN ('CANCELLED', 'RESCHEDULED'))
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_time_order" CHECK ("scheduled_end" > "scheduled_start");
-- A cancelled session always says why; any other status has no cancellation reason.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_cancel_complete"
  CHECK (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL));
-- A regular session comes from a timetable entry; make-up and replacement sessions do not.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_kind_source"
  CHECK (("kind" = 'REGULAR') = ("timetable_entry_id" IS NOT NULL));

-- Class history is append-only, like the audit log.
CREATE TRIGGER "class_events_append_only" BEFORE UPDATE OR DELETE ON "class_events"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
