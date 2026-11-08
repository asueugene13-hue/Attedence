-- CreateEnum
CREATE TYPE "SemesterStatus" AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "CalendarExceptionType" AS ENUM ('PUBLIC_HOLIDAY', 'UNIVERSITY_CLOSURE', 'EXAM_PERIOD', 'OTHER');

-- CreateTable
CREATE TABLE "faculties" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faculties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "faculty_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programmes" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qualification" TEXT,
    "duration_years" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_levels" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academic_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_years" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semesters" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "SemesterStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semesters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_exceptions" (
    "id" UUID NOT NULL,
    "semester_id" UUID,
    "type" "CalendarExceptionType" NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "suppresses_classes" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "faculties_code_key" ON "faculties"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE INDEX "departments_faculty_id_idx" ON "departments"("faculty_id");

-- CreateIndex
CREATE UNIQUE INDEX "programmes_code_key" ON "programmes"("code");

-- CreateIndex
CREATE INDEX "programmes_department_id_idx" ON "programmes"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_levels_code_key" ON "academic_levels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "academic_levels_sort_order_key" ON "academic_levels"("sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_label_key" ON "academic_years"("label");

-- CreateIndex
CREATE UNIQUE INDEX "semesters_academic_year_id_number_key" ON "semesters"("academic_year_id", "number");

-- CreateIndex
CREATE INDEX "calendar_exceptions_start_date_end_date_idx" ON "calendar_exceptions"("start_date", "end_date");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "faculties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programmes" ADD CONSTRAINT "programmes_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written rules (docs/DATABASE_SCHEMA.md §4).
-- ─────────────────────────────────────────────────────────────────────────────

-- Codes are stored in capitals so "csc" and "CSC" cannot become two records.
ALTER TABLE "faculties"       ADD CONSTRAINT "faculties_code_upper"       CHECK ("code" = upper("code"));
ALTER TABLE "departments"     ADD CONSTRAINT "departments_code_upper"     CHECK ("code" = upper("code"));
ALTER TABLE "programmes"      ADD CONSTRAINT "programmes_code_upper"      CHECK ("code" = upper("code"));
ALTER TABLE "academic_levels" ADD CONSTRAINT "academic_levels_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "programmes"      ADD CONSTRAINT "programmes_duration_positive" CHECK ("duration_years" IS NULL OR "duration_years" BETWEEN 1 AND 10);

-- Dates run forwards.
ALTER TABLE "academic_years"      ADD CONSTRAINT "academic_years_dates"      CHECK ("end_date" > "start_date");
ALTER TABLE "semesters"           ADD CONSTRAINT "semesters_dates"           CHECK ("end_date" > "start_date");
ALTER TABLE "semesters"           ADD CONSTRAINT "semesters_number_positive" CHECK ("number" >= 1);
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_dates" CHECK ("end_date" >= "start_date");

-- Academic years never overlap, and neither do semesters (inclusive date ranges).
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_no_overlap"
  EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_no_overlap"
  EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);

-- One current academic year; at most one active semester.
CREATE UNIQUE INDEX "academic_years_one_current" ON "academic_years" ((true)) WHERE "is_current";
CREATE UNIQUE INDEX "semesters_one_active" ON "semesters" ((true)) WHERE "status" = 'ACTIVE';
