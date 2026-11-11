-- CreateEnum
CREATE TYPE "BeaconProtocol" AS ENUM ('EDDYSTONE_EID', 'VENDOR_ROTATING', 'EDDYSTONE_UID', 'IBEACON');

-- CreateEnum
CREATE TYPE "BeaconStatus" AS ENUM ('ACTIVE', 'SUSPECTED_FAULTY', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SurveyPosition" AS ENUM ('INSIDE_FRONT', 'INSIDE_MIDDLE', 'INSIDE_BACK_ROW', 'INSIDE_CORNER', 'DOORWAY', 'CORRIDOR', 'NEIGHBOUR_ROOM', 'OUTSIDE_BUILDING');

-- CreateTable
CREATE TABLE "beacons" (
    "id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "protocol" "BeaconProtocol" NOT NULL,
    "identifier" TEXT NOT NULL,
    "rotation_key_enc" TEXT,
    "rotation_exponent" INTEGER,
    "tx_power_dbm" INTEGER,
    "threshold_rssi" INTEGER,
    "status" "BeaconStatus" NOT NULL DEFAULT 'ACTIVE',
    "battery_percent" INTEGER,
    "battery_reported_at" TIMESTAMPTZ(3),
    "installed_on" DATE,
    "calibrated_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "beacons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calibration_surveys" (
    "id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "surveyed_by_id" UUID NOT NULL,
    "surveyed_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "result" JSONB NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "applied_by_id" UUID,

    CONSTRAINT "calibration_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calibration_measurements" (
    "id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "beacon_id" UUID NOT NULL,
    "phone_model" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "position" "SurveyPosition" NOT NULL,
    "rssi" INTEGER NOT NULL,

    CONSTRAINT "calibration_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "beacons_classroom_id_idx" ON "beacons"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "beacons_protocol_identifier_key" ON "beacons"("protocol", "identifier");

-- CreateIndex
CREATE INDEX "calibration_surveys_classroom_id_surveyed_at_idx" ON "calibration_surveys"("classroom_id", "surveyed_at");

-- CreateIndex
CREATE INDEX "calibration_measurements_survey_id_idx" ON "calibration_measurements"("survey_id");

-- CreateIndex
CREATE INDEX "calibration_measurements_beacon_id_idx" ON "calibration_measurements"("beacon_id");

-- AddForeignKey
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_surveys" ADD CONSTRAINT "calibration_surveys_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_surveys" ADD CONSTRAINT "calibration_surveys_surveyed_by_id_fkey" FOREIGN KEY ("surveyed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_surveys" ADD CONSTRAINT "calibration_surveys_applied_by_id_fkey" FOREIGN KEY ("applied_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_measurements" ADD CONSTRAINT "calibration_measurements_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "calibration_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_measurements" ADD CONSTRAINT "calibration_measurements_beacon_id_fkey" FOREIGN KEY ("beacon_id") REFERENCES "beacons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (listed in docs/DATABASE_SCHEMA.md §4).
-- Rotating protocols need their key and (for Eddystone-EID) the rotation exponent; fixed ones have neither.
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_rotation_complete"
  CHECK (("protocol" IN ('EDDYSTONE_EID', 'VENDOR_ROTATING')) = ("rotation_key_enc" IS NOT NULL)
     AND ("protocol" = 'EDDYSTONE_EID') = ("rotation_exponent" IS NOT NULL));
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_rotation_exponent_range" CHECK ("rotation_exponent" IS NULL OR "rotation_exponent" BETWEEN 0 AND 15);
-- Signal strengths are negative dBm; battery is a percentage; identifiers are stored lower-case.
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_threshold_range" CHECK ("threshold_rssi" IS NULL OR "threshold_rssi" BETWEEN -120 AND -20);
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_battery_range" CHECK ("battery_percent" IS NULL OR "battery_percent" BETWEEN 0 AND 100);
ALTER TABLE "beacons" ADD CONSTRAINT "beacons_identifier_lower" CHECK ("identifier" = lower("identifier"));
ALTER TABLE "calibration_measurements" ADD CONSTRAINT "calibration_measurements_rssi_range" CHECK ("rssi" BETWEEN -120 AND 0);
-- A survey's readings are kept exactly as recorded.
CREATE TRIGGER "calibration_measurements_append_only"
  BEFORE UPDATE OR DELETE ON "calibration_measurements"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
-- An applied survey says who applied it, and when.
ALTER TABLE "calibration_surveys" ADD CONSTRAINT "calibration_surveys_applied_complete"
  CHECK (("applied_at" IS NULL) = ("applied_by_id" IS NULL));
