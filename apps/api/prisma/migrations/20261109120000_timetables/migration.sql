-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Recurrence" AS ENUM ('WEEKLY', 'EVERY_OTHER_WEEK', 'SELECTED_WEEKS', 'ONCE');

-- CreateTable
CREATE TABLE "timetables" (
    "id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_entries" (
    "id" UUID NOT NULL,
    "timetable_id" UUID NOT NULL,
    "lecturer_id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "recurrence" "Recurrence" NOT NULL DEFAULT 'WEEKLY',
    "selected_weeks" INTEGER[],
    "effective_from" DATE NOT NULL,
    "effective_to" DATE NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timetable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_entry_sections" (
    "entry_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,

    CONSTRAINT "timetable_entry_sections_pkey" PRIMARY KEY ("entry_id","section_id")
);

-- CreateTable
CREATE TABLE "timetable_entry_exceptions" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_entry_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_changes" (
    "id" UUID NOT NULL,
    "timetable_id" UUID NOT NULL,
    "entry_id" UUID,
    "change_type" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "changed_by_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "timetables_semester_id_version_key" ON "timetables"("semester_id", "version");

-- CreateIndex
CREATE INDEX "timetable_entries_timetable_id_idx" ON "timetable_entries"("timetable_id");

-- CreateIndex
CREATE INDEX "timetable_entry_sections_section_id_idx" ON "timetable_entry_sections"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entry_exceptions_entry_id_date_key" ON "timetable_entry_exceptions"("entry_id", "date");

-- CreateIndex
CREATE INDEX "timetable_changes_timetable_id_changed_at_idx" ON "timetable_changes"("timetable_id", "changed_at");

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entry_sections" ADD CONSTRAINT "timetable_entry_sections_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "timetable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entry_sections" ADD CONSTRAINT "timetable_entry_sections_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entry_exceptions" ADD CONSTRAINT "timetable_entry_exceptions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "timetable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entry_exceptions" ADD CONSTRAINT "timetable_entry_exceptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_changes" ADD CONSTRAINT "timetable_changes_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_changes" ADD CONSTRAINT "timetable_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- At most one draft and one published timetable per semester.
CREATE UNIQUE INDEX "timetables_one_draft" ON "timetables" ("semester_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "timetables_one_published" ON "timetables" ("semester_id") WHERE "status" = 'PUBLISHED';
-- A published timetable says who published it and when.
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_publish_complete"
  CHECK (("published_at" IS NULL) = ("published_by_id" IS NULL)
     AND ("status" = 'DRAFT') = ("published_at" IS NULL));
-- Entry times and dates make sense; a one-time class has a single date.
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_times_valid"
  CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute");
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_day_valid" CHECK ("day_of_week" BETWEEN 1 AND 7);
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_dates_valid" CHECK ("effective_from" <= "effective_to");
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_once_single_day"
  CHECK ("recurrence" <> 'ONCE' OR "effective_from" = "effective_to");
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_selected_weeks"
  CHECK (("recurrence" = 'SELECTED_WEEKS') = (cardinality("selected_weeks") > 0));
