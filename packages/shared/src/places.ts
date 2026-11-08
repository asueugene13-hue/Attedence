import { z } from 'zod';
import { CodeSchema, NameSchema } from './academic.js';

/**
 * Request shapes for campuses, buildings and classrooms (Phase 2, step 2).
 * A geofence is the centre of a campus or building and a radius in metres, taken from a site survey.
 * `null` clears it; leaving it out keeps the current value.
 */
export const GeofenceSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(20, 'must be at least 20 m').max(5000, 'must be at most 5,000 m'),
});
export type Geofence = z.infer<typeof GeofenceSchema>;

export const CreateCampusSchema = z.strictObject({
  code: CodeSchema,
  name: NameSchema,
  geofence: GeofenceSchema.optional(),
});
export const UpdateCampusSchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  geofence: GeofenceSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const CreateBuildingSchema = z.strictObject({
  campusId: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  geofence: GeofenceSchema.optional(),
});
export const UpdateBuildingSchema = UpdateCampusSchema;

const floor = z.string().trim().min(1).max(20);
const capacity = z.number().int().min(1).max(5000);

export const CreateClassroomSchema = z.strictObject({
  buildingId: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  floor: floor.optional(),
  capacity: capacity.optional(),
});
export const UpdateClassroomSchema = z.strictObject({
  code: CodeSchema.optional(),
  name: NameSchema.optional(),
  floor: floor.nullable().optional(),
  capacity: capacity.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const PlacesQuerySchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  campusId: z.uuid().optional(),
  buildingId: z.uuid().optional(),
  minCapacity: z.coerce.number().int().min(1).max(5000).optional(),
});
