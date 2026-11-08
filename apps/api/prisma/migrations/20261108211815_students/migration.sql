-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'DEFERRED', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED');

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "student_number" TEXT NOT NULL,
    "programme_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "current_academic_year_id" UUID NOT NULL,
    "current_semester_id" UUID NOT NULL,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "no_device_exemption" BOOLEAN NOT NULL DEFAULT false,
    "registered_by_id" UUID NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_user_id_key" ON "student_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_student_number_key" ON "student_profiles"("student_number");

-- CreateIndex
CREATE INDEX "student_profiles_programme_id_level_id_idx" ON "student_profiles"("programme_id", "level_id");

-- CreateIndex
CREATE INDEX "student_profiles_status_idx" ON "student_profiles"("status");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "academic_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_current_academic_year_id_fkey" FOREIGN KEY ("current_academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_current_semester_id_fkey" FOREIGN KEY ("current_semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written rules (docs/DATABASE_SCHEMA.md §4).
-- The Student ID format (8 digits) is checked by the API, not here, so a format change does not need
-- a database migration.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_verification_complete"
  CHECK (("verified_at" IS NULL) = ("verified_by_id" IS NULL));
