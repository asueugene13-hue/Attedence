import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  AppointCourseRepSchema,
  EndEnrollmentSchema,
  EnrollmentQuerySchema,
  EnrollSchema,
  IdSchema,
  NominateCourseRepSchema,
  ReasonOnlySchema,
} from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated, RequirePermissions } from '../authorization/access.decorators.js';
import { CourseRepsService } from './course-reps.service.js';
import { EnrollmentsService } from './enrollments.service.js';

const id = (value: string) => parseInput(IdSchema, value);

@Controller()
export class EnrollmentsController {
  constructor(
    private readonly enrollments: EnrollmentsService,
    private readonly reps: CourseRepsService,
  ) {}

  // ── Enrolments ──

  @Post('enrollments')
  @RequirePermissions('enrollments.manage')
  enroll(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.enrollments.enroll(auth, parseInput(EnrollSchema, body), requestContextOf(req));
  }

  @Get('enrollments')
  @RequirePermissions('enrollments.manage')
  list(@Query() query: unknown) {
    return this.enrollments.list(parseInput(EnrollmentQuerySchema, query));
  }

  @Get('enrollments/:id')
  @RequirePermissions('enrollments.manage')
  get(@Param('id') param: string) {
    return this.enrollments.get(id(param));
  }

  /** Drop or withdraw, with a reason. The record is kept. */
  @Post('enrollments/:id/end')
  @RequirePermissions('enrollments.manage')
  @HttpCode(200)
  end(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.enrollments.end(
      auth,
      id(param),
      parseInput(EndEnrollmentSchema, body),
      requestContextOf(req),
    );
  }

  /** Enrolment staff, or a lecturer of this section (checked in the service). */
  @Get('course-sections/:id/students')
  @Authenticated()
  roster(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.enrollments.roster(auth, id(param));
  }

  @Get('me/enrollments')
  @Authenticated()
  myEnrollments(@CurrentAuth() auth: AccessClaims) {
    return this.enrollments.mine(auth.userId);
  }

  // ── Course reps (D-12) ──

  /** Administrators within scope, or a lecturer of this section (checked in the service). */
  @Get('course-sections/:id/course-reps')
  @Authenticated()
  listReps(@CurrentAuth() auth: AccessClaims, @Param('id') param: string) {
    return this.reps.listForSection(auth, id(param));
  }

  @Post('course-sections/:id/course-reps')
  @RequirePermissions('course_reps.assign')
  appoint(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reps.appoint(
      auth,
      id(param),
      parseInput(AppointCourseRepSchema, body),
      requestContextOf(req),
    );
  }

  @Post('course-sections/:id/course-rep-nominations')
  @RequirePermissions('course_reps.nominate')
  nominate(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reps.nominate(
      auth,
      id(param),
      parseInput(NominateCourseRepSchema, body),
      requestContextOf(req),
    );
  }

  @Post('course-reps/:id/approve')
  @RequirePermissions('course_reps.assign')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AccessClaims, @Param('id') param: string, @Req() req: Request) {
    return this.reps.approve(auth, id(param), requestContextOf(req));
  }

  @Post('course-reps/:id/reject')
  @RequirePermissions('course_reps.assign')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reps.reject(
      auth,
      id(param),
      parseInput(ReasonOnlySchema, body).reason,
      requestContextOf(req),
    );
  }

  @Post('course-reps/:id/end')
  @RequirePermissions('course_reps.assign')
  @HttpCode(200)
  endRep(
    @CurrentAuth() auth: AccessClaims,
    @Param('id') param: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.reps.end(auth, id(param), parseInput(ReasonOnlySchema, body).reason, requestContextOf(req));
  }

  @Get('me/course-reps')
  @Authenticated()
  myReps(@CurrentAuth() auth: AccessClaims) {
    return this.reps.mine(auth.userId);
  }
}
