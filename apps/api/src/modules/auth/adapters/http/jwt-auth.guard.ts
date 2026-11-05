import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { unauthorized } from '../../application/auth.errors';
import { AuthService } from '../../application/auth.service';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { AuthenticatedRequest } from './authenticated-request';

const accessTokenPayloadSchema = z.object({ sub: z.uuid() });

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = await this.resolveUserId(request.headers.authorization);
    request.user = await this.auth.resolveActiveUser(userId);
    return true;
  }

  private async resolveUserId(header: string | undefined): Promise<string> {
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw unauthorized('UNAUTHENTICATED');
    }

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<object>(token);
    } catch {
      throw unauthorized('UNAUTHENTICATED');
    }

    const parsed = accessTokenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw unauthorized('UNAUTHENTICATED');
    }
    return parsed.data.sub;
  }
}
