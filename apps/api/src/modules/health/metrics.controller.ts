import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Header, Headers, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { Public } from '../authorization/access.decorators.js';
import { MetricsService } from './metrics.service.js';

/**
 * GET /metrics, in Prometheus text format, for the university's monitoring (Phase 7 step 4). Off unless
 * METRICS_TOKEN is set; then the scraper must send it as a Bearer token. Nothing personal is exposed.
 */
@Public()
@Controller()
export class MetricsController {
  constructor(
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Headers('authorization') authorization: string | undefined) {
    const token = this.config.metricsToken;
    if (!token) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found.' });
    const given = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'A valid metrics token is required.',
      });
    }
    return this.metrics.text();
  }
}
