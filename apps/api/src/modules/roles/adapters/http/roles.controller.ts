import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role, RoleList } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { RequirePermissions } from '../../../auth/adapters/http/auth.decorators';
import { AuthErrorDto } from '../../../auth/adapters/http/auth.dto';
import { RolesService } from '../../application/roles.service';
import { CreateRoleDto, RoleDto, RoleErrorDto, RoleIdParamDto, RoleListDto, UpdateRoleDto } from './roles.dto';

function RoleNotFoundDocs(): MethodDecorator {
  return applyDecorators(
    ApiNotFoundResponse({
      description: 'No role with this id',
      type: RoleErrorDto.Output,
      example: { statusCode: 404, code: 'ROLE_NOT_FOUND', message: 'Role not found' },
    }),
  );
}

function InvalidBodyDocs(): MethodDecorator {
  return ApiBadRequestResponse({
    description: 'Invalid id, blank or too long name, permission outside the catalog, or duplicated permissions',
  });
}

@ApiTags('roles')
@RequirePermissions('roles:manage')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid or expired token, or the user is no longer active',
  type: AuthErrorDto.Output,
  example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
})
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @ApiOperation({ summary: 'List roles with their permissions and the number of non-deleted users assigned' })
  @ZodResponse({ status: 200, description: 'All roles', type: RoleListDto })
  list(): Promise<RoleList> {
    return this.roles.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a role with its permissions' })
  @ZodResponse({ status: 200, description: 'The role', type: RoleDto })
  @ApiBadRequestResponse({ description: 'The id is not a valid UUID' })
  @RoleNotFoundDocs()
  get(@Param() params: RoleIdParamDto): Promise<Role> {
    return this.roles.get(params.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a role with permissions from the catalog' })
  @ApiBody({
    type: CreateRoleDto,
    examples: { auditor: { value: { name: 'Auditor', permissions: ['inventory:read', 'dashboard:view'] } } },
  })
  @ZodResponse({ status: 201, description: 'Created role', type: RoleDto })
  @InvalidBodyDocs()
  @ApiConflictResponse({
    description: 'Another role already uses this name, ignoring case',
    type: RoleErrorDto.Output,
    example: { statusCode: 409, code: 'ROLE_NAME_TAKEN', message: 'A role with this name already exists' },
  })
  create(@Body() body: CreateRoleDto): Promise<Role> {
    return this.roles.create(body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a role and/or replace its permissions; changes apply to its users on their next request',
  })
  @ApiBody({
    type: UpdateRoleDto,
    examples: {
      rename: { value: { name: 'Inventory auditor' } },
      permissions: { value: { permissions: ['inventory:read', 'inventory:write', 'dashboard:view'] } },
    },
  })
  @ZodResponse({ status: 200, description: 'Updated role', type: RoleDto })
  @InvalidBodyDocs()
  @RoleNotFoundDocs()
  @ApiConflictResponse({
    description:
      'System role, name already used by another role, or the change would leave no active user with users:manage and roles:manage',
    type: RoleErrorDto.Output,
    examples: {
      system: {
        summary: 'System role',
        value: { statusCode: 409, code: 'SYSTEM_ROLE_IMMUTABLE', message: 'System roles cannot be changed or deleted' },
      },
      nameTaken: {
        summary: 'Name taken',
        value: { statusCode: 409, code: 'ROLE_NAME_TAKEN', message: 'A role with this name already exists' },
      },
      lastAdmin: {
        summary: 'Last governance role',
        value: {
          statusCode: 409,
          code: 'LAST_ADMIN_PROTECTED',
          message: 'At least one active user must keep the users:manage and roles:manage permissions',
        },
      },
    },
  })
  update(@Param() params: RoleIdParamDto, @Body() body: UpdateRoleDto): Promise<Role> {
    return this.roles.update(params.id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role that has no non-deleted users' })
  @ApiNoContentResponse({ description: 'Role deleted' })
  @ApiBadRequestResponse({ description: 'The id is not a valid UUID' })
  @RoleNotFoundDocs()
  @ApiConflictResponse({
    description: 'System role, or the role is still assigned to users',
    type: RoleErrorDto.Output,
    examples: {
      system: {
        summary: 'System role',
        value: { statusCode: 409, code: 'SYSTEM_ROLE_IMMUTABLE', message: 'System roles cannot be changed or deleted' },
      },
      inUse: {
        summary: 'Role in use',
        value: {
          statusCode: 409,
          code: 'ROLE_IN_USE',
          message: 'The role is assigned to users and cannot be deleted',
          userCount: 3,
        },
      },
    },
  })
  async remove(@Param() params: RoleIdParamDto): Promise<void> {
    await this.roles.remove(params.id);
  }
}
