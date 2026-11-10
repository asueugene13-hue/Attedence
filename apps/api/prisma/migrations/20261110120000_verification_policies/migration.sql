-- CreateTable
CREATE TABLE "verification_policies" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_policies_version_key" ON "verification_policies"("version");

-- AddForeignKey
ALTER TABLE "verification_policies" ADD CONSTRAINT "verification_policies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Versions are never edited or deleted (like the audit log).
CREATE TRIGGER "verification_policies_append_only"
  BEFORE UPDATE OR DELETE ON "verification_policies"
  FOR EACH ROW EXECUTE FUNCTION block_history_change();
ALTER TABLE "verification_policies" ADD CONSTRAINT "verification_policies_version_positive" CHECK ("version" >= 1);
