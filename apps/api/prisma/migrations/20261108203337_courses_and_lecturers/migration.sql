-- CreateEnum
CREATE TYPE "OfferingStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "credit_hours" INTEGER,
    "department_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_offerings" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "status" "OfferingStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_sections" (
    "id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "capacity" INTEGER,
    "programme_id" UUID,
    "level_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lecturer_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "staff_number" TEXT NOT NULL,
    "department_id" UUID NOT NULL,
    "title" TEXT,
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lecturer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lecturer_assignments" (
    "id" UUID NOT NULL,
    "lecturer_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_id" UUID,

    CONSTRAINT "lecturer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courses_code_key" ON "courses"("code");

-- CreateIndex
CREATE INDEX "courses_department_id_idx" ON "courses"("department_id");

-- CreateIndex
CREATE INDEX "course_offerings_semester_id_idx" ON "course_offerings"("semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_offerings_course_id_semester_id_key" ON "course_offerings"("course_id", "semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_sections_offering_id_code_key" ON "course_sections"("offering_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_profiles_user_id_key" ON "lecturer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_profiles_staff_number_key" ON "lecturer_profiles"("staff_number");

-- CreateIndex
CREATE INDEX "lecturer_profiles_department_id_idx" ON "lecturer_profiles"("department_id");

-- CreateIndex
CREATE INDEX "lecturer_assignments_section_id_idx" ON "lecturer_assignments"("section_id");

-- CreateIndex
CREATE INDEX "lecturer_assignments_lecturer_id_idx" ON "lecturer_assignments"("lecturer_id");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "academic_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_profiles" ADD CONSTRAINT "lecturer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_profiles" ADD CONSTRAINT "lecturer_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_assignments" ADD CONSTRAINT "lecturer_assignments_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_assignments" ADD CONSTRAINT "lecturer_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_assignments" ADD CONSTRAINT "lecturer_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_assignments" ADD CONSTRAINT "lecturer_assignments_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written rules (docs/DATABASE_SCHEMA.md §4).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "courses"           ADD CONSTRAINT "courses_code_upper"         CHECK ("code" = upper("code"));
ALTER TABLE "courses"           ADD CONSTRAINT "courses_credit_hours_range" CHECK ("credit_hours" IS NULL OR "credit_hours" BETWEEN 0 AND 60);
ALTER TABLE "course_sections"   ADD CONSTRAINT "course_sections_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "course_sections"   ADD CONSTRAINT "course_sections_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 5000);
ALTER TABLE "lecturer_profiles" ADD CONSTRAINT "lecturer_profiles_staff_number_upper" CHECK ("staff_number" = upper("staff_number"));

-- An ended assignment records who ended it.
ALTER TABLE "lecturer_assignments" ADD CONSTRAINT "lecturer_assignments_end_complete"
  CHECK (("ended_at" IS NULL) = ("ended_by_id" IS NULL));

-- One active assignment per lecturer and section; at most one active primary lecturer per section.
CREATE UNIQUE INDEX "lecturer_assignments_active_unique" ON "lecturer_assignments" ("lecturer_id", "section_id")
  WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "lecturer_assignments_one_primary" ON "lecturer_assignments" ("section_id")
  WHERE "ended_at" IS NULL AND "is_primary";
