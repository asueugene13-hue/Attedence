import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  AssignLecturerSchema,
  CourseQuerySchema,
  CreateCourseSchema,
  CreateLecturerSchema,
  CreateOfferingSchema,
  CreateSectionSchema,
  EndAssignmentSchema,
  IdSchema,
  UpdateCourseSchema,
  UpdateLecturerSchema,
  UpdateSectionSchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { CoursesService } from './courses.service.js';
import { LecturersService } from './lecturers.service.js';

const id = (value: string) => parseInput(IdSchema, value);

@Controller()
export class CoursesController {
  constructor(
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
  ) {}

  // ───────── Courses ─────────

  @Get('courses')
  @RequirePermissions('academic_structure.read')
  listCourses(@Query() query: unknown) {
    return this.courses.listCourses(parseInput(CourseQuerySchema, query));
  }

  @Post('courses')
  @RequirePermissions('courses.manage')
  createCourse(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.courses.createCourse(auth, parseInput(CreateCourseSchema, body), requestContextOf(req));
  }

  @Patch('courses/:id')
  @RequirePermissions('courses.manage')
  updateCourse(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.courses.updateCourse(
      auth,
      id(param),
      parseInput(UpdateCourseSchema, body),
      requestContextOf(req),
    );
  }

  // ───────── Offerings and sections ─────────

  @Get('course-offerings')
  @RequirePermissions('academic_structure.read')
  listOfferings(@Query() query: unknown) {
    return this.courses.listOfferings(parseInput(CourseQuerySchema, query));
  }

  @Post('course-offerings')
  @RequirePermissions('courses.manage')
  createOffering(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.courses.createOffering(auth, parseInput(CreateOfferingSchema, body), requestContextOf(req));
  }

  @Post('course-offerings/:id/open')
  @RequirePermissions('courses.manage')
  @HttpCode(200)
  openOffering(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.courses.setOfferingStatus(auth, id(param), 'OPEN', requestContextOf(req));
  }

  @Post('course-offerings/:id/close')
  @RequirePermissions('courses.manage')
  @HttpCode(200)
  closeOffering(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.courses.setOfferingStatus(auth, id(param), 'CLOSED', requestContextOf(req));
  }

  @Post('course-sections')
  @RequirePermissions('courses.manage')
  createSection(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.courses.createSection(auth, parseInput(CreateSectionSchema, body), requestContextOf(req));
  }

  @Patch('course-sections/:id')
  @RequirePermissions('courses.manage')
  updateSection(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.courses.updateSection(
      auth,
      id(param),
      parseInput(UpdateSectionSchema, body),
      requestContextOf(req),
    );
  }

  // ───────── Lecturers and assignments ─────────

  @Get('lecturers')
  @RequirePermissions('academic_structure.read')
  listLecturers(@Query() query: unknown) {
    return this.lecturers.listLecturers(parseInput(CourseQuerySchema, query));
  }

  @Get('lecturers/:id')
  @RequirePermissions('academic_structure.read')
  getLecturer(@Param('id') param: string) {
    return this.lecturers.getLecturer(id(param));
  }

  @Post('lecturers')
  @RequirePermissions('lecturers.manage')
  createLecturer(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.lecturers.createLecturer(auth, parseInput(CreateLecturerSchema, body), requestContextOf(req));
  }

  @Patch('lecturers/:id')
  @RequirePermissions('lecturers.manage')
  updateLecturer(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.lecturers.updateLecturer(
      auth,
      id(param),
      parseInput(UpdateLecturerSchema, body),
      requestContextOf(req),
    );
  }

  @Post('course-sections/:id/lecturers')
  @RequirePermissions('lecturer_assignments.manage')
  assign(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.lecturers.assign(
      auth,
      id(param),
      parseInput(AssignLecturerSchema, body),
      requestContextOf(req),
    );
  }

  @Post('course-sections/:id/lecturers/:assignmentId/end')
  @RequirePermissions('lecturer_assignments.manage')
  @HttpCode(204)
  async endAssignment(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.lecturers.endAssignment(
      auth,
      id(param),
      id(assignmentId),
      parseInput(EndAssignmentSchema, body).reason,
      requestContextOf(req),
    );
  }

  /** A lecturer's own current class groups. Anyone signed in may ask; non-lecturers get an empty list. */
  @Get('me/teaching')
  @Authenticated()
  myTeaching(@CurrentAuth() auth: AccessClaims) {
    return this.lecturers.myTeaching(auth.userId);
  }
}
