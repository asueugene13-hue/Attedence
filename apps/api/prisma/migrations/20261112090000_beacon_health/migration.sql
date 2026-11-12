-- CreateEnum
CREATE TYPE "ObservationBluetooth" AS ENUM ('ON', 'OFF', 'DENIED');

-- CreateEnum
CREATE TYPE "ObservationGps" AS ENUM ('INSIDE', 'OUTSIDE', 'UNCERTAIN', 'MOCKED');

-- AlterEnum
ALTER TYPE "ClassEventType" ADD VALUE 'BEACON_DEGRADED';

-- CreateTable
CREATE TABLE "beacon_observations" (
    "id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "class_session_id" UUID,
    "device_id" UUID NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "bluetooth" "ObservationBluetooth" NOT NULL,
    "gps" "ObservationGps" NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_m" INTEGER,

    CONSTRAINT "beacon_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beacon_sightings" (
    "id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "beacon_id" UUID NOT NULL,
    "rssi" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "beacon_sightings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beacon_health_snapshots" (
    "id" UUID NOT NULL,
    "beacon_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "sightings" INTEGER NOT NULL,
    "distinct_devices" INTEGER NOT NULL,
    "median_rssi" INTEGER,

    CONSTRAINT "beacon_health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "beacon_observations_classroom_id_observed_at_idx" ON "beacon_observations"("classroom_id", "observed_at");

-- CreateIndex
CREATE INDEX "beacon_observations_observed_at_idx" ON "beacon_observations"("observed_at");

-- CreateIndex
CREATE INDEX "beacon_sightings_beacon_id_observed_at_idx" ON "beacon_sightings"("beacon_id", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "beacon_sightings_observation_id_beacon_id_key" ON "beacon_sightings"("observation_id", "beacon_id");

-- CreateIndex
CREATE UNIQUE INDEX "beacon_health_snapshots_beacon_id_window_start_key" ON "beacon_health_snapshots"("beacon_id", "window_start");

-- AddForeignKey
ALTER TABLE "beacon_observations" ADD CONSTRAINT "beacon_observations_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beacon_observations" ADD CONSTRAINT "beacon_observations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beacon_sightings" ADD CONSTRAINT "beacon_sightings_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "beacon_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beacon_sightings" ADD CONSTRAINT "beacon_sightings_beacon_id_fkey" FOREIGN KEY ("beacon_id") REFERENCES "beacons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beacon_health_snapshots" ADD CONSTRAINT "beacon_health_snapshots_beacon_id_fkey" FOREIGN KEY ("beacon_id") REFERENCES "beacons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Observations and sightings are evidence: kept exactly as reported.
CREATE TRIGGER "beacon_observations_append_only"
  BEFORE UPDATE OR DELETE ON "beacon_observations"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
CREATE TRIGGER "beacon_sightings_append_only"
  BEFORE UPDATE OR DELETE ON "beacon_sightings"
  FOR EACH ROW EXECUTE FUNCTION "block_history_change"();
-- Plausible values only.
ALTER TABLE "beacon_sightings" ADD CONSTRAINT "beacon_sightings_rssi_range" CHECK ("rssi" BETWEEN -120 AND 0);
ALTER TABLE "beacon_observations" ADD CONSTRAINT "beacon_observations_location_complete"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL OR "accuracy_m" IS NOT NULL));
ALTER TABLE "beacon_health_snapshots" ADD CONSTRAINT "beacon_health_snapshots_counts"
  CHECK ("sightings" >= 0 AND "distinct_devices" >= 0 AND "distinct_devices" <= "sightings");
