import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  CreateAcademicYearSchema,
  CreateCalendarExceptionSchema,
  CreateDepartmentSchema,
  CreateFacultySchema,
  CreateLevelSchema,
  CreateProgrammeSchema,
  CreateSemesterSchema,
  IdSchema,
  ListQuerySchema,
  ReasonOnlySchema,
  UpdateAcademicYearSchema,
  UpdateDepartmentSchema,
  UpdateFacultySchema,
  UpdateLevelSchema,
  UpdateProgrammeSchema,
  UpdateSemesterSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RequirePermissions } from '../authorization/access.decorators.js';
import { AcademicPeriodsService } from './academic-periods.service.js';
import { AcademicStructureService } from './academic-structure.service.js';

const id = (value: string) => parseInput(IdSchema, value);

@Controller()
export class AcademicController {
  constructor(
    private readonly structure: AcademicStructureService,
    private readonly periods: AcademicPeriodsService,
  ) {}

  // ───────── Faculties, departments, programmes, levels ─────────

  @Get('faculties')
  @RequirePermissions('academic_structure.read')
  listFaculties(@Query() query: unknown) {
    return this.structure.listFaculties(parseInput(ListQuerySchema, query).includeInactive);
  }

  @Post('faculties')
  @RequirePermissions('academic_structure.manage')
  createFaculty(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.structure.createFaculty(auth, parseInput(CreateFacultySchema, body), requestContextOf(req));
  }

  @Patch('faculties/:id')
  @RequirePermissions('academic_structure.manage')
  updateFaculty(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.structure.updateFaculty(
      auth,
      id(param),
      parseInput(UpdateFacultySchema, body),
      requestContextOf(req),
    );
  }

  @Get('departments')
  @RequirePermissions('academic_structure.read')
  listDepartments(@Query() query: unknown) {
    const q = parseInput(ListQuerySchema, query);
    return this.structure.listDepartments(q.includeInactive, q.facultyId);
  }

  @Post('departments')
  @RequirePermissions('academic_structure.manage')
  createDepartment(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.structure.createDepartment(
      auth,
      parseInput(CreateDepartmentSchema, body),
      requestContextOf(req),
    );
  }

  @Patch('departments/:id')
  @RequirePermissions('academic_structure.manage')
  updateDepartment(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.structure.updateDepartment(
      auth,
      id(param),
      parseInput(UpdateDepartmentSchema, body),
      requestContextOf(req),
    );
  }

  @Get('programmes')
  @RequirePermissions('academic_structure.read')
  listProgrammes(@Query() query: unknown) {
    const q = parseInput(ListQuerySchema, query);
    return this.structure.listProgrammes(q.includeInactive, {
      departmentId: q.departmentId,
      facultyId: q.facultyId,
    });
  }

  @Post('programmes')
  @RequirePermissions('academic_structure.manage')
  createProgramme(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.structure.createProgramme(
      auth,
      parseInput(CreateProgrammeSchema, body),
      requestContextOf(req),
    );
  }

  @Patch('programmes/:id')
  @RequirePermissions('academic_structure.manage')
  updateProgramme(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.structure.updateProgramme(
      auth,
      id(param),
      parseInput(UpdateProgrammeSchema, body),
      requestContextOf(req),
    );
  }

  @Get('academic-levels')
  @RequirePermissions('academic_structure.read')
  listLevels(@Query() query: unknown) {
    return this.structure.listLevels(parseInput(ListQuerySchema, query).includeInactive);
  }

  @Post('academic-levels')
  @RequirePermissions('academic_structure.manage')
  createLevel(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.structure.createLevel(auth, parseInput(CreateLevelSchema, body), requestContextOf(req));
  }

  @Patch('academic-levels/:id')
  @RequirePermissions('academic_structure.manage')
  updateLevel(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.structure.updateLevel(
      auth,
      id(param),
      parseInput(UpdateLevelSchema, body),
      requestContextOf(req),
    );
  }

  // ───────── Academic years, semesters, calendar ─────────

  @Get('academic-years')
  @RequirePermissions('academic_structure.read')
  listYears() {
    return this.periods.listYears();
  }

  @Post('academic-years')
  @RequirePermissions('academic_periods.manage')
  createYear(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.periods.createYear(auth, parseInput(CreateAcademicYearSchema, body), requestContextOf(req));
  }

  @Patch('academic-years/:id')
  @RequirePermissions('academic_periods.manage')
  updateYear(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.periods.updateYear(
      auth,
      id(param),
      parseInput(UpdateAcademicYearSchema, body),
      requestContextOf(req),
    );
  }

  @Post('academic-years/:id/make-current')
  @RequirePermissions('academic_periods.manage')
  @HttpCode(200)
  makeCurrent(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.periods.makeYearCurrent(auth, id(param), requestContextOf(req));
  }

  @Get('semesters')
  @RequirePermissions('academic_structure.read')
  listSemesters(@Query() query: unknown) {
    return this.periods.listSemesters(parseInput(ListQuerySchema, query).academicYearId);
  }

  @Post('semesters')
  @RequirePermissions('academic_periods.manage')
  createSemester(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.periods.createSemester(auth, parseInput(CreateSemesterSchema, body), requestContextOf(req));
  }

  @Patch('semesters/:id')
  @RequirePermissions('academic_periods.manage')
  updateSemester(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.periods.updateSemester(
      auth,
      id(param),
      parseInput(UpdateSemesterSchema, body),
      requestContextOf(req),
    );
  }

  @Post('semesters/:id/activate')
  @RequirePermissions('academic_periods.manage')
  @HttpCode(200)
  activate(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.periods.activateSemester(auth, id(param), requestContextOf(req));
  }

  @Post('semesters/:id/close')
  @RequirePermissions('academic_periods.manage')
  @HttpCode(200)
  close(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.periods.closeSemester(auth, id(param), requestContextOf(req));
  }

  @Get('calendar-exceptions')
  @RequirePermissions('academic_structure.read')
  listExceptions(@Query() query: unknown) {
    const q = parseInput(ListQuerySchema, query);
    return this.periods.listExceptions({ semesterId: q.semesterId, from: q.from, to: q.to });
  }

  @Post('calendar-exceptions')
  @RequirePermissions('academic_periods.manage')
  createException(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.periods.createException(
      auth,
      parseInput(CreateCalendarExceptionSchema, body),
      requestContextOf(req),
    );
  }

  @Post('calendar-exceptions/:id/remove')
  @RequirePermissions('academic_periods.manage')
  @HttpCode(204)
  async removeException(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.periods.removeException(
      auth,
      id(param),
      parseInput(ReasonOnlySchema, body).reason,
      requestContextOf(req),
    );
  }
}
