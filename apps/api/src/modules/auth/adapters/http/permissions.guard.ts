import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@stockpile/shared';
import { forbidden, unauthorized } from '../../application/auth.errors';
import { hasAllPermissions } from '../../domain/permissions';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from './auth.decorators';
import { AuthenticatedRequest } from './authenticated-request';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndMerge<Permission[]>(REQUIRED_PERMISSIONS_KEY, targets);
    if (required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) {
      throw unauthorized('UNAUTHENTICATED');
    }
    if (!hasAllPermissions(user.permissions, required)) {
      throw forbidden('ACCESS_DENIED');
    }
    return true;
  }
}
