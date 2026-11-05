import { ExecutionContext, SetMetadata, applyDecorators, createParamDecorator } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse } from '@nestjs/swagger';
import { AuthUser, Permission } from '@stockpile/shared';
import { unauthorized } from '../../application/auth.errors';
import { AuthErrorDto } from './auth.dto';
import { AuthenticatedRequest } from './authenticated-request';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'auth:requiredPermissions';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    ApiBearerAuth(),
    ApiForbiddenResponse({
      description: `Requires permissions: ${permissions.join(', ')}`,
      type: AuthErrorDto.Output,
      example: { statusCode: 403, code: 'ACCESS_DENIED', message: 'You do not have permission to access this resource' },
    }),
  );

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) {
    throw unauthorized('UNAUTHENTICATED');
  }
  return user;
});
