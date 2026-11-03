import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { REDIS } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis =>
        new Redis(config.get('REDIS_URL'), { maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') {
      await this.redis.quit();
    }
  }
}
