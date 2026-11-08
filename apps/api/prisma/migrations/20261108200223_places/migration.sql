-- CreateTable
CREATE TABLE "campuses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "geofence_lat" DECIMAL(9,6),
    "geofence_lng" DECIMAL(9,6),
    "geofence_radius_m" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "geofence_lat" DECIMAL(9,6),
    "geofence_lng" DECIMAL(9,6),
    "geofence_radius_m" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classrooms" (
    "id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" TEXT,
    "capacity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "classrooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campuses_code_key" ON "campuses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "buildings_campus_id_code_key" ON "buildings"("campus_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_building_id_code_key" ON "classrooms"("building_id", "code");

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written rules (docs/DATABASE_SCHEMA.md §4).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "campuses"   ADD CONSTRAINT "campuses_code_upper"   CHECK ("code" = upper("code"));
ALTER TABLE "buildings"  ADD CONSTRAINT "buildings_code_upper"  CHECK ("code" = upper("code"));
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 5000);

-- A geofence is all three values or none, with real coordinates and a sensible radius.
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_geofence_valid" CHECK (
  ("geofence_lat" IS NULL AND "geofence_lng" IS NULL AND "geofence_radius_m" IS NULL)
  OR ("geofence_lat" BETWEEN -90 AND 90 AND "geofence_lng" BETWEEN -180 AND 180 AND "geofence_radius_m" BETWEEN 20 AND 5000));
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_geofence_valid" CHECK (
  ("geofence_lat" IS NULL AND "geofence_lng" IS NULL AND "geofence_radius_m" IS NULL)
  OR ("geofence_lat" BETWEEN -90 AND 90 AND "geofence_lng" BETWEEN -180 AND 180 AND "geofence_radius_m" BETWEEN 20 AND 5000));
