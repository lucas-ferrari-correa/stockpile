import { Inject, Injectable } from '@nestjs/common';
import { HealthStatus } from '@stockpile/shared';
import Redis from 'ioredis';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { REDIS } from '../../../infra/redis/redis.constants';
import { IMPORT_QUEUE, ImportQueue } from '../../imports/ports/import-queue';

type ComponentStatus = HealthStatus['checks']['database'];

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueue,
  ) {}

  async check(): Promise<HealthStatus> {
    const [database, redis, queue] = await Promise.all([this.checkDatabase(), this.checkRedis(), this.checkQueue()]);
    return {
      status: database === 'up' && redis === 'up' && queue === 'up' ? 'ok' : 'degraded',
      checks: { database, redis, queue },
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

  private async checkQueue(): Promise<ComponentStatus> {
    return (await this.queue.isReady()) ? 'up' : 'down';
  }
}
