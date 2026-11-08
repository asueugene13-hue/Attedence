import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateBuildingSchema,
  CreateCampusSchema,
  CreateClassroomSchema,
  Geofence,
  UpdateBuildingSchema,
  UpdateCampusSchema,
  UpdateClassroomSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';

type GeofenceColumns = {
  geofenceLat: Prisma.Decimal | null;
  geofenceLng: Prisma.Decimal | null;
  geofenceRadiusM: number | null;
};

/** Geofence input → columns: undefined keeps the current value, null clears it. */
function geofenceColumns(input: Geofence | null | undefined) {
  if (input === undefined) return {};
  if (input === null) return { geofenceLat: null, geofenceLng: null, geofenceRadiusM: null };
  return { geofenceLat: input.lat, geofenceLng: input.lng, geofenceRadiusM: input.radiusM };
}

export function geofenceOf(row: GeofenceColumns): Geofence | null {
  if (row.geofenceLat === null || row.geofenceLng === null || row.geofenceRadiusM === null) return null;
  return { lat: Number(row.geofenceLat), lng: Number(row.geofenceLng), radiusM: row.geofenceRadiusM };
}

function view<T extends GeofenceColumns>(row: T) {
  const { geofenceLat: _lat, geofenceLng: _lng, geofenceRadiusM: _r, ...rest } = row;
  return { ...rest, geofence: geofenceOf(row) };
}

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const inUse = (what: string, where: string) => ({
  unique: { code: 'CODE_IN_USE', message: `Another ${what} ${where} already uses that code.` },
});

/**
 * Campuses, buildings and classrooms. Rooms serve every faculty, so changes need university-wide scope.
 * Deactivated, never deleted: timetables and attendance history keep pointing at them.
 */
@Injectable()
export class PlacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
  ) {}

  // ───────── Campuses ─────────

  async listCampuses(includeInactive: boolean) {
    const rows = await this.prisma.campus.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { buildings: { where: { isActive: true } } } } },
    });
    return rows.map(view);
  }

  async createCampus(
    actor: AccessClaims,
    input: z.output<typeof CreateCampusSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const row = await tx.campus.create({
          data: { code: input.code, name: input.name, ...geofenceColumns(input.geofence) },
        });
        await this.record(tx, actor, 'places.campus.created', 'campus', row.id, null, view(row), context);
        return view(row);
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('campus', '')));
  }

  async updateCampus(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateCampusSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.campus.findUnique({ where: { id } });
        if (!before) throw notFound('campus');
        if (input.isActive === false && before.isActive) {
          const active = await tx.building.count({ where: { campusId: id, isActive: true } });
          if (active > 0) throw hasActiveChildren('campus', active, 'building');
        }
        const after = await tx.campus.update({
          where: { id },
          data: {
            code: input.code,
            name: input.name,
            isActive: input.isActive,
            ...geofenceColumns(input.geofence),
          },
        });
        await this.record(
          tx,
          actor,
          'places.campus.updated',
          'campus',
          id,
          view(before),
          view(after),
          context,
        );
        return view(after);
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('campus', '')));
  }

  // ───────── Buildings ─────────

  async listBuildings(includeInactive: boolean, campusId?: string) {
    const rows = await this.prisma.building.findMany({
      where: { ...(includeInactive ? {} : { isActive: true }), ...(campusId ? { campusId } : {}) },
      orderBy: { name: 'asc' },
      include: {
        campus: { select: { id: true, code: true, name: true } },
        _count: { select: { classrooms: { where: { isActive: true } } } },
      },
    });
    return rows.map(view);
  }

  async createBuilding(
    actor: AccessClaims,
    input: z.output<typeof CreateBuildingSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    const campus = await this.prisma.campus.findUnique({ where: { id: input.campusId } });
    if (!campus) throw notFound('campus');
    if (!campus.isActive) throw inactiveParent('campus');
    return this.prisma
      .$transaction(async (tx) => {
        const row = await tx.building.create({
          data: {
            campusId: input.campusId,
            code: input.code,
            name: input.name,
            ...geofenceColumns(input.geofence),
          },
        });
        await this.record(tx, actor, 'places.building.created', 'building', row.id, null, view(row), context);
        return view(row);
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('building', 'on this campus')));
  }

  async updateBuilding(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateBuildingSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.building.findUnique({ where: { id }, include: { campus: true } });
        if (!before) throw notFound('building');
        if (input.isActive === false && before.isActive) {
          const active = await tx.classroom.count({ where: { buildingId: id, isActive: true } });
          if (active > 0) throw hasActiveChildren('building', active, 'classroom');
        }
        if (input.isActive === true && !before.isActive && !before.campus.isActive)
          throw inactiveParent('campus');
        const after = await tx.building.update({
          where: { id },
          data: {
            code: input.code,
            name: input.name,
            isActive: input.isActive,
            ...geofenceColumns(input.geofence),
          },
        });
        const { campus: _campus, ...beforeRow } = before;
        await this.record(
          tx,
          actor,
          'places.building.updated',
          'building',
          id,
          view(beforeRow),
          view(after),
          context,
        );
        return view(after);
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('building', 'on this campus')));
  }

  // ───────── Classrooms ─────────

  /** Rooms with their building and campus, and the geofence that applies to them (building's, else campus's). */
  async listClassrooms(filter: {
    includeInactive: boolean;
    buildingId?: string;
    campusId?: string;
    minCapacity?: number;
  }) {
    const rows = await this.prisma.classroom.findMany({
      where: {
        ...(filter.includeInactive ? {} : { isActive: true }),
        ...(filter.buildingId ? { buildingId: filter.buildingId } : {}),
        ...(filter.campusId ? { building: { campusId: filter.campusId } } : {}),
        ...(filter.minCapacity ? { capacity: { gte: filter.minCapacity } } : {}),
      },
      orderBy: [{ building: { name: 'asc' } }, { code: 'asc' }],
      include: { building: { include: { campus: true } } },
    });
    return rows.map(({ building, ...room }) => ({
      ...room,
      building: { id: building.id, code: building.code, name: building.name },
      campus: { id: building.campus.id, code: building.campus.code, name: building.campus.name },
      geofence: geofenceOf(building) ?? geofenceOf(building.campus),
    }));
  }

  async createClassroom(
    actor: AccessClaims,
    input: z.output<typeof CreateClassroomSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    const building = await this.prisma.building.findUnique({ where: { id: input.buildingId } });
    if (!building) throw notFound('building');
    if (!building.isActive) throw inactiveParent('building');
    return this.prisma
      .$transaction(async (tx) => {
        const row = await tx.classroom.create({ data: input });
        await this.record(tx, actor, 'places.classroom.created', 'classroom', row.id, null, row, context);
        return row;
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('room', 'in this building')));
  }

  async updateClassroom(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateClassroomSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.classroom.findUnique({ where: { id }, include: { building: true } });
        if (!before) throw notFound('classroom');
        if (input.isActive === true && !before.isActive && !before.building.isActive)
          throw inactiveParent('building');
        const after = await tx.classroom.update({ where: { id }, data: input });
        const { building: _building, ...beforeRow } = before;
        await this.record(tx, actor, 'places.classroom.updated', 'classroom', id, beforeRow, after, context);
        return after;
      })
      .catch((e: unknown) => rethrowAsConflict(e, inUse('room', 'in this building')));
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    action: string,
    entityType: string,
    entityId: string,
    before: object | null,
    after: object,
    context: RequestContext,
  ) {
    await this.audit.record(
      {
        action,
        entityType,
        entityId,
        actorUserId: actor.userId,
        actorRoleKey: actor.role,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: JSON.parse(JSON.stringify(after)),
        context,
      },
      tx,
    );
  }
}

function hasActiveChildren(what: string, count: number, child: string) {
  return new ConflictException({
    code: 'HAS_ACTIVE_CHILDREN',
    message: `This ${what} still has ${count} active ${child}${count === 1 ? '' : 's'}. Deactivate them first.`,
  });
}

function inactiveParent(what: string) {
  return new BadRequestException({
    code: 'PARENT_INACTIVE',
    message: `The ${what} is inactive. Reactivate it first.`,
  });
}
