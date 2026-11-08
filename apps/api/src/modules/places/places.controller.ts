import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  CreateBuildingSchema,
  CreateCampusSchema,
  CreateClassroomSchema,
  IdSchema,
  PlacesQuerySchema,
  UpdateBuildingSchema,
  UpdateCampusSchema,
  UpdateClassroomSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { PlacesService } from './places.service.js';

const id = (value: string) => parseInput(IdSchema, value);

/** Room names and locations are not sensitive: every role that sees a timetable may read them. */
@Controller()
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('campuses')
  @RequirePermissions('timetables.read')
  listCampuses(@Query() query: unknown) {
    return this.places.listCampuses(parseInput(PlacesQuerySchema, query).includeInactive);
  }

  @Post('campuses')
  @RequirePermissions('classrooms.manage')
  createCampus(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.places.createCampus(auth, parseInput(CreateCampusSchema, body), requestContextOf(req));
  }

  @Patch('campuses/:id')
  @RequirePermissions('classrooms.manage')
  updateCampus(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.places.updateCampus(
      auth,
      id(param),
      parseInput(UpdateCampusSchema, body),
      requestContextOf(req),
    );
  }

  @Get('buildings')
  @RequirePermissions('timetables.read')
  listBuildings(@Query() query: unknown) {
    const q = parseInput(PlacesQuerySchema, query);
    return this.places.listBuildings(q.includeInactive, q.campusId);
  }

  @Post('buildings')
  @RequirePermissions('classrooms.manage')
  createBuilding(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.places.createBuilding(auth, parseInput(CreateBuildingSchema, body), requestContextOf(req));
  }

  @Patch('buildings/:id')
  @RequirePermissions('classrooms.manage')
  updateBuilding(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.places.updateBuilding(
      auth,
      id(param),
      parseInput(UpdateBuildingSchema, body),
      requestContextOf(req),
    );
  }

  @Get('classrooms')
  @RequirePermissions('timetables.read')
  listClassrooms(@Query() query: unknown) {
    return this.places.listClassrooms(parseInput(PlacesQuerySchema, query));
  }

  @Post('classrooms')
  @RequirePermissions('classrooms.manage')
  createClassroom(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.places.createClassroom(auth, parseInput(CreateClassroomSchema, body), requestContextOf(req));
  }

  @Patch('classrooms/:id')
  @RequirePermissions('classrooms.manage')
  updateClassroom(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.places.updateClassroom(
      auth,
      id(param),
      parseInput(UpdateClassroomSchema, body),
      requestContextOf(req),
    );
  }
}
