-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('SECTION_SUMMARY', 'SECTION_REGISTER', 'ATTENDANCE_ANALYTICS', 'CLASS_OPERATIONS', 'STUDENT_ENROLMENTS');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'EXPORT_FILE';

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_role" TEXT NOT NULL,
    "report_type" "ReportType" NOT NULL,
    "params" JSONB NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "contains_personal_data" BOOLEAN NOT NULL,
    "title" TEXT,
    "file_id" UUID,
    "row_count" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "last_downloaded_at" TIMESTAMPTZ(3),

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_exports_file_id_key" ON "report_exports"("file_id");

-- CreateIndex
CREATE INDEX "report_exports_requested_by_id_created_at_idx" ON "report_exports"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "report_exports_status_expires_at_idx" ON "report_exports"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- A finished file has its rows, its file and its expiry; a failed one says why.
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_states"
  CHECK (("status" = 'READY') = ("file_id" IS NOT NULL AND "status" = 'READY')
     AND ("status" <> 'READY' OR ("row_count" IS NOT NULL AND "expires_at" IS NOT NULL AND "completed_at" IS NOT NULL))
     AND ("status" <> 'FAILED' OR "error" IS NOT NULL)
     AND "download_count" >= 0);
