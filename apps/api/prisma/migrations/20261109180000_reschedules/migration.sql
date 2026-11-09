-- CreateEnum
CREATE TYPE "RescheduleStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "class_sessions" ADD COLUMN     "cancelled_by_timetable_change" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rescheduled_from_id" UUID;

-- CreateTable
CREATE TABLE "reschedule_requests" (
    "id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "proposed_start" TIMESTAMPTZ(3) NOT NULL,
    "proposed_end" TIMESTAMPTZ(3) NOT NULL,
    "proposed_classroom_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RescheduleStatus" NOT NULL DEFAULT 'PENDING',
    "is_direct" BOOLEAN NOT NULL DEFAULT false,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "replacement_session_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reschedule_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_requests_replacement_session_id_key" ON "reschedule_requests"("replacement_session_id");

-- CreateIndex
CREATE INDEX "reschedule_requests_status_created_at_idx" ON "reschedule_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "reschedule_requests_class_session_id_idx" ON "reschedule_requests"("class_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_sessions_rescheduled_from_id_key" ON "class_sessions"("rescheduled_from_id");

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_class_session_id_fkey" FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_replacement_session_id_fkey" FOREIGN KEY ("replacement_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_proposed_classroom_id_fkey" FOREIGN KEY ("proposed_classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- At most one pending reschedule request per class.
CREATE UNIQUE INDEX "reschedule_requests_one_pending" ON "reschedule_requests" ("class_session_id") WHERE "status" = 'PENDING';
-- A decided request says who decided and when; an approved one names its replacement session.
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_decision_complete"
  CHECK (("status" = 'PENDING') = ("decided_at" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by_id" IS NULL)
     AND ("status" = 'APPROVED') = ("replacement_session_id" IS NOT NULL));
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_time_order" CHECK ("proposed_end" > "proposed_start");
-- Only a replacement session points back to the session it replaces.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_replacement_link"
  CHECK (("kind" = 'REPLACEMENT') = ("rescheduled_from_id" IS NOT NULL));
