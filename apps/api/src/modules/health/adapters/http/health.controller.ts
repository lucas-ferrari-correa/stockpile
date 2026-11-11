import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthStatus } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { Public } from '../../../auth/adapters/http/auth.decorators';
import { HealthService } from '../../application/health.service';
import { HealthStatusDto } from './health.dto';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) { }

  @Get()
  @ApiOperation({ summary: 'Check connectivity with Postgres, Redis and the import queue' })
  @ZodResponse({ status: 200, description: 'All dependencies are reachable', type: HealthStatusDto })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down', type: HealthStatusDto.Output })
  async check(): Promise<HealthStatus> {
    const status = await this.health.check();

    if (status.status !== 'ok') {
      throw new ServiceUnavailableException(status);
    }

    return status;
  }
}
