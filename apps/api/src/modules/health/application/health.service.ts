import { Inject, Injectable } from '@nestjs/common';
import { HealthStatus } from '@stockpile/shared';
import Redis from 'ioredis';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { REDIS } from '../../../infra/redis/redis.constants';

type ComponentStatus = HealthStatus['checks']['database'];

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthStatus> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<ComponentStatus> {
    try {
      return (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
