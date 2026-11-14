-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('OFFICIAL', 'COURSE_REP');

-- CreateEnum
CREATE TYPE "AnnouncementScope" AS ENUM ('SECTION', 'DEPARTMENT', 'FACULTY', 'INSTITUTION');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "author_role" TEXT NOT NULL,
    "kind" "AnnouncementKind" NOT NULL,
    "scope" "AnnouncementScope" NOT NULL,
    "department_id" UUID,
    "faculty_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'PUBLISHED',
    "hidden_by_id" UUID,
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_reason" TEXT,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_sections" (
    "announcement_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,

    CONSTRAINT "announcement_sections_pkey" PRIMARY KEY ("announcement_id","section_id")
);

-- CreateTable
CREATE TABLE "announcement_recipients" (
    "announcement_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "announcement_recipients_pkey" PRIMARY KEY ("announcement_id","user_id")
);

-- CreateTable
CREATE TABLE "announcement_reports" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "announcement_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_author_id_sent_at_idx" ON "announcements"("author_id", "sent_at");

-- CreateIndex
CREATE INDEX "announcements_status_sent_at_idx" ON "announcements"("status", "sent_at");

-- CreateIndex
CREATE INDEX "announcement_sections_section_id_idx" ON "announcement_sections"("section_id");

-- CreateIndex
CREATE INDEX "announcement_recipients_user_id_announcement_id_idx" ON "announcement_recipients"("user_id", "announcement_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_reports_announcement_id_reporter_id_key" ON "announcement_reports"("announcement_id", "reporter_id");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_hidden_by_id_fkey" FOREIGN KEY ("hidden_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "faculties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_sections" ADD CONSTRAINT "announcement_sections_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_sections" ADD CONSTRAINT "announcement_sections_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reports" ADD CONSTRAINT "announcement_reports_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reports" ADD CONSTRAINT "announcement_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- The audience matches the scope; a course rep's update goes to sections only; title and body have text.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_audience"
  CHECK ((("scope" = 'DEPARTMENT') = ("department_id" IS NOT NULL))
     AND (("scope" = 'FACULTY') = ("faculty_id" IS NOT NULL))
     AND ("kind" = 'OFFICIAL' OR "scope" = 'SECTION')
     AND length(trim("title")) >= 3 AND length(trim("body")) >= 1);
-- A hidden announcement says who hid it, when and why.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_hidden"
  CHECK (("status" = 'HIDDEN') = ("hidden_at" IS NOT NULL)
     AND ("hidden_at" IS NULL) = ("hidden_by_id" IS NULL)
     AND ("status" <> 'HIDDEN' OR length(trim("hidden_reason")) >= 5));
-- Reports are history.
CREATE TRIGGER "announcement_reports_append_only" BEFORE UPDATE OR DELETE ON "announcement_reports"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
