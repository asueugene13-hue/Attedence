-- CreateEnum
CREATE TYPE "VerificationOutcome" AS ENUM ('VERIFIED', 'PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeciderType" AS ENUM ('ENGINE', 'LECTURER', 'ADMINISTRATOR');

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "attempt_id" UUID;

-- CreateTable
CREATE TABLE "attendance_attempts" (
    "id" UUID NOT NULL,
    "attendance_session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "qr_window" INTEGER,
    "delayed_upload" BOOLEAN NOT NULL DEFAULT false,
    "outcome" "VerificationOutcome" NOT NULL,
    "reason" TEXT,
    "retry_allowed" BOOLEAN NOT NULL,
    "can_ask_for_review" BOOLEAN NOT NULL,
    "evidence" JSONB NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "app_version" TEXT,

    CONSTRAINT "attendance_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_decisions" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL,
    "decided_by" "DeciderType" NOT NULL,
    "decided_by_id" UUID,
    "policy_version" INTEGER NOT NULL,
    "rule_trace" JSONB NOT NULL,
    "note" TEXT,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_attempts_attendance_session_id_student_id_idx" ON "attendance_attempts"("attendance_session_id", "student_id");

-- CreateIndex
CREATE INDEX "attendance_attempts_attendance_session_id_outcome_idx" ON "attendance_attempts"("attendance_session_id", "outcome");

-- CreateIndex
CREATE INDEX "attendance_attempts_device_id_received_at_idx" ON "attendance_attempts"("device_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_attempts_student_id_idempotency_key_key" ON "attendance_attempts"("student_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "verification_decisions_attempt_id_decided_at_idx" ON "verification_decisions"("attempt_id", "decided_at");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attendance_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_attempts" ADD CONSTRAINT "attendance_attempts_attendance_session_id_fkey" FOREIGN KEY ("attendance_session_id") REFERENCES "attendance_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_attempts" ADD CONSTRAINT "attendance_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_attempts" ADD CONSTRAINT "attendance_attempts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attendance_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Attempts and decisions are evidence: never changed or removed.
CREATE TRIGGER "attendance_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "attendance_attempts"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
CREATE TRIGGER "verification_decisions_append_only"
  BEFORE UPDATE OR DELETE ON "verification_decisions"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
-- A reviewer's decision says who decided; the engine's does not.
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_decider"
  CHECK (("decided_by" = 'ENGINE') = ("decided_by_id" IS NULL));
