import { UseGuards, applyDecorators } from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthErrorDto } from './auth.dto';
import { RateLimitGuard } from './rate-limit.guard';

export const RATE_LIMITS = ['login', 'access-request'] as const;

export type RateLimitName = (typeof RATE_LIMITS)[number];

export const RateLimit = (name: RateLimitName): MethodDecorator =>
  applyDecorators(
    SkipThrottle(Object.fromEntries(RATE_LIMITS.filter((other) => other !== name).map((other) => [other, true]))),
    UseGuards(RateLimitGuard),
    ApiTooManyRequestsResponse({
      description: 'Too many attempts from this client IP address; retry after the number of seconds in Retry-After',
      type: AuthErrorDto.Output,
      headers: {
        'Retry-After': { description: 'Seconds until a new attempt is accepted', schema: { type: 'integer', minimum: 1 } },
      },
      example: { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    }),
  );
