import { STATUS_CODES } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string | undefined;
  errors?: unknown;
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Turns every error into an RFC 9457 "problem details" body (docs/API_DOCUMENTATION.md §1).
 * Unexpected errors are logged in full but described to the caller only in general terms,
 * so internal details never leak to users.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const problem = this.toProblem(exception, request.id);

    if (problem.status >= 500 && !(exception instanceof HttpException)) {
      this.logger.error(
        { err: exception, requestId: request.id },
        `Unhandled error on ${request.method} ${request.url}`,
      );
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, requestId: string | undefined): ProblemDetails {
    if (!(exception instanceof HttpException)) {
      return {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred. Quote the request ID if you report it.',
        code: 'INTERNAL_ERROR',
        requestId,
      };
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const message = typeof body === 'string' ? body : fields.message;
    const problem: ProblemDetails = {
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail: Array.isArray(message)
        ? message.join('; ')
        : typeof message === 'string'
          ? message
          : exception.message,
      code: typeof fields.code === 'string' ? fields.code : (DEFAULT_CODES[status] ?? 'ERROR'),
      requestId,
    };
    // Health checks report which dependency failed; validation errors list each field.
    const errors = fields.details ?? fields.errors;
    if (errors !== undefined) problem.errors = errors;
    return problem;
  }
}
