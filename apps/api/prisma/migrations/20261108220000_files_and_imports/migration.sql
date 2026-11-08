-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('PROFILE_PHOTO', 'IMPORT_FILE');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('STORED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('STUDENTS');

-- CreateEnum
CREATE TYPE "ImportFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('VALIDATED', 'IMPORTING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'DUPLICATE_IN_FILE', 'DUPLICATE_EXISTING', 'IMPORTED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "photo_file_id" UUID;

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "purpose" "FilePurpose" NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_name" TEXT,
    "status" "FileStatus" NOT NULL DEFAULT 'STORED',
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "type" "ImportType" NOT NULL,
    "format" "ImportFormat" NOT NULL,
    "file_id" UUID NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'VALIDATED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "errors" JSONB,
    "status" "ImportRowStatus" NOT NULL,
    "created_entity_id" UUID,
    "email_status" "EmailStatus",

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_key_key" ON "file_objects"("key");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_file_id_key" ON "import_batches"("file_id");

-- CreateIndex
CREATE INDEX "import_batches_type_created_at_idx" ON "import_batches"("type", "created_at");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_status_idx" ON "import_rows"("batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_batch_id_row_number_key" ON "import_rows"("batch_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_photo_file_id_key" ON "student_profiles"("photo_file_id");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_photo_file_id_fkey" FOREIGN KEY ("photo_file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_size_positive" CHECK ("size_bytes" > 0);
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_removal_complete"
  CHECK (("status" = 'REMOVED') = ("removed_at" IS NOT NULL));
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_decision_complete"
  CHECK (("decided_at" IS NULL) = ("decided_by_id" IS NULL));
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_valid"
  CHECK ("total_rows" >= 0 AND "valid_rows" >= 0 AND "invalid_rows" >= 0 AND "duplicate_rows" >= 0
         AND "imported_rows" >= 0 AND "valid_rows" + "invalid_rows" + "duplicate_rows" <= "total_rows");
-- Row 1 is the header, so data starts at row 2.
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_row_number_valid" CHECK ("row_number" >= 2);
