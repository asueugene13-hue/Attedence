-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'DROPPED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CourseRepStatus" AS ENUM ('NOMINATED', 'ACTIVE', 'ENDED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ImportType" ADD VALUE 'ENROLLMENTS';

-- CreateTable
CREATE TABLE "course_enrollments" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_id" UUID,
    "end_reason" TEXT,
    "import_batch_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_rep_assignments" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "status" "CourseRepStatus" NOT NULL,
    "nominated_by_id" UUID,
    "nomination_note" TEXT,
    "assigned_by_id" UUID,
    "starts_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_id" UUID,
    "end_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_rep_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_enrollments_section_id_status_idx" ON "course_enrollments"("section_id", "status");

-- CreateIndex
CREATE INDEX "course_enrollments_student_id_status_idx" ON "course_enrollments"("student_id", "status");

-- CreateIndex
CREATE INDEX "course_rep_assignments_section_id_status_idx" ON "course_rep_assignments"("section_id", "status");

-- CreateIndex
CREATE INDEX "course_rep_assignments_student_id_status_idx" ON "course_rep_assignments"("student_id", "status");

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_nominated_by_id_fkey" FOREIGN KEY ("nominated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- One active enrolment per student and offering; dropped and withdrawn rows stay as history.
CREATE UNIQUE INDEX "course_enrollments_active_unique"
  ON "course_enrollments" ("student_id", "offering_id") WHERE "status" = 'ENROLLED';
-- An ended enrolment records when, by whom and why; an active one has none of these.
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_end_complete"
  CHECK (("status" = 'ENROLLED') = ("ended_at" IS NULL)
     AND ("ended_at" IS NULL) = ("ended_by_id" IS NULL)
     AND ("ended_at" IS NULL) = ("end_reason" IS NULL));

-- One open course-rep assignment (nominated or active) per student and section.
CREATE UNIQUE INDEX "course_rep_assignments_open_unique"
  ON "course_rep_assignments" ("student_id", "section_id") WHERE "status" IN ('NOMINATED', 'ACTIVE');
-- A nomination says who nominated; an active or ended appointment says who appointed and from when.
ALTER TABLE "course_rep_assignments" ADD CONSTRAINT "course_rep_assignments_state_complete"
  CHECK (("status" <> 'NOMINATED' OR "nominated_by_id" IS NOT NULL)
     AND ("status" NOT IN ('ACTIVE', 'ENDED') OR ("assigned_by_id" IS NOT NULL AND "starts_at" IS NOT NULL))
     AND (("status" IN ('ENDED', 'REJECTED')) = ("ended_at" IS NOT NULL))
     AND ("ended_at" IS NULL) = ("ended_by_id" IS NULL)
     AND ("ended_at" IS NULL) = ("end_reason" IS NULL));
