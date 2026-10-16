import { Controller, Get } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  /** Liveness: the process is up and serving HTTP. Readiness (DB + broker) arrives with #17. */
  @Get('live')
  live(): HealthStatus {
    return { status: 'ok' };
  }
}
