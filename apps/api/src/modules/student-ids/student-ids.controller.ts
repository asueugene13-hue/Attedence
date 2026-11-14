import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { CheckStudentIdSchema } from '@attendsure/shared';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { CurrentAuth } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { Authenticated } from '../authorization/access.decorators.js';
import { StudentIdsService } from './student-ids.service.js';

/** The digital student ID (Phase 6 step 5). Roles are checked in the service. */
@Controller()
export class StudentIdsController {
  constructor(private readonly ids: StudentIdsService) {}

  /** The signed-in student's card with a fresh code (ask again every `refreshAfterSeconds`). */
  @Get('me/student-id')
  @Authenticated()
  card(@CurrentAuth() auth: AccessClaims) {
    return this.ids.myCard(auth);
  }

  /** A short-lived link to the signed-in student's own photo. `404 NO_PHOTO` if there is none. */
  @Get('me/student-id/photo')
  @Authenticated()
  photo(@CurrentAuth() auth: AccessClaims) {
    return this.ids.myPhoto(auth);
  }

  /** `{ code }` scanned from a student's card: staff only; every check is logged. */
  @Post('student-ids/check')
  @Authenticated()
  @HttpCode(200)
  check(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.ids.check(auth, parseInput(CheckStudentIdSchema, body).code, requestContextOf(req));
  }
}
