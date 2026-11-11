import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { REDIS } from '../../../../infra/redis/redis.constants';
import { RateLimitName } from './rate-limit.decorator';

const THROTTLE_KEY_PREFIX = 'throttle';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, REDIS],
      useFactory: (config: AppConfigService, redis: Redis): ThrottlerModuleOptions => {
        const throttlers: { name: RateLimitName; limit: number; ttl: number }[] = [
          { name: 'login', limit: config.get('THROTTLE_LOGIN_LIMIT'), ttl: config.get('THROTTLE_LOGIN_TTL_MS') },
          {
            name: 'access-request',
            limit: config.get('THROTTLE_ACCESS_REQUEST_LIMIT'),
            ttl: config.get('THROTTLE_ACCESS_REQUEST_TTL_MS'),
          },
        ];
        return {
          throttlers,
          storage: new ThrottlerStorageRedisService(redis),
          generateKey: (_context, tracker) => `${THROTTLE_KEY_PREFIX}:${tracker}`,
          setHeaders: false,
        };
      },
    }),
  ],
})
export class RateLimitModule {}
