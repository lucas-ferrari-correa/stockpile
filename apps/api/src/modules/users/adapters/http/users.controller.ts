import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AuthUser, UserListItem, UserPage } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { ApiSearchQuery } from '../../../../infra/http/search-query-docs';
import { CurrentUser, RequirePermissions } from '../../../auth/adapters/http/auth.decorators';
import { AuthErrorDto } from '../../../auth/adapters/http/auth.dto';
import { UsersService } from '../../application/users.service';
import {
  ApproveUserDto,
  ChangeUserRoleDto,
  UserErrorDto,
  UserIdParamDto,
  UserListItemDto,
  UserListQueryDto,
  UserPageDto,
} from './users.dto';

const EXAMPLE_ROLE_ID = '5b0f8a52-3c0e-4c4f-9d43-2f7a3c1c9e10';

function UserActionDocs(summary: string): MethodDecorator {
  return applyDecorators(
    ApiOperation({ summary }),
    ZodResponse({ status: 200, description: 'Updated user', type: UserListItemDto }),
    ApiBadRequestResponse({ description: 'The id is not a valid UUID or the body is malformed' }),
    ApiNotFoundResponse({
      description: 'No user with this id',
      type: UserErrorDto.Output,
      example: { statusCode: 404, code: 'USER_NOT_FOUND', message: 'User not found' },
    }),
    ApiConflictResponse({
      description:
        'Transition not allowed from the current status, action on own account, or it would leave no active user with users:manage and roles:manage',
      type: UserErrorDto.Output,
      example: {
        statusCode: 409,
        code: 'INVALID_TRANSITION',
        message: 'This action is not allowed for the current status of the user',
      },
    }),
  );
}

function RoleAssignmentDocs(body: typeof ApproveUserDto | typeof ChangeUserRoleDto): MethodDecorator {
  return applyDecorators(
    ApiBody({ type: body, examples: { role: { value: { roleId: EXAMPLE_ROLE_ID } } } }),
    ApiUnprocessableEntityResponse({
      description: 'The roleId does not match an existing role',
      type: UserErrorDto.Output,
      example: { statusCode: 422, code: 'ROLE_NOT_FOUND', message: 'The selected role does not exist' },
    }),
  );
}

@ApiTags('users')
@RequirePermissions('users:manage')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid or expired token, or the user is no longer active',
  type: AuthErrorDto.Output,
  example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
})
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'List users with filters, search, sorting and keyset pagination',
    description: [
      'Sorted by createdAt, newest first, unless sort and order say otherwise. status and roleId accept several values by repeating the parameter. createdFrom and createdTo are inclusive YYYY-MM-DD days in the IANA time zone tz.',
      'Pagination is keyset based: pass nextCursor back as cursor with the same sort and order. total is the number of matching users on the first page and null on pages requested with a cursor.',
    ].join('\n\n'),
  })
  @ApiSearchQuery(
    'General search. Matches users whose name or email contains the term (case-insensitive), whose status contains it, or who were created on a date such as 10/27/2026, 10/27 (any year) or 10/2026 (whole month) in the time zone tz.',
    { name: 'maria', email: '@example.com', status: 'pending', day: '10/27/2026', month: '10/2026' },
  )
  @ZodResponse({ status: 200, description: 'A page of users', type: UserPageDto })
  @ApiBadRequestResponse({
    description:
      'Invalid query parameters, or a cursor that is malformed, does not match sort and order, or points to no user',
    type: UserErrorDto.Output,
    example: { statusCode: 400, code: 'INVALID_CURSOR', message: 'The cursor does not match any user' },
  })
  list(@Query() query: UserListQueryDto): Promise<UserPage> {
    return this.users.list(query);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UserActionDocs('Approve a pending access request and assign a role')
  @RoleAssignmentDocs(ApproveUserDto)
  approve(
    @Param() params: UserIdParamDto,
    @Body() body: ApproveUserDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserListItem> {
    return this.users.apply({ action: 'approve', roleId: body.roleId }, params.id, actor.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UserActionDocs('Reject a pending access request')
  reject(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<UserListItem> {
    return this.users.apply({ action: 'reject' }, params.id, actor.id);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @UserActionDocs('Block an active user')
  block(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<UserListItem> {
    return this.users.apply({ action: 'block' }, params.id, actor.id);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @UserActionDocs('Unblock a blocked user')
  unblock(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<UserListItem> {
    return this.users.apply({ action: 'unblock' }, params.id, actor.id);
  }

  @Patch(':id/role')
  @UserActionDocs('Change the role of an active or blocked user')
  @RoleAssignmentDocs(ChangeUserRoleDto)
  changeRole(
    @Param() params: UserIdParamDto,
    @Body() body: ChangeUserRoleDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserListItem> {
    return this.users.apply({ action: 'changeRole', roleId: body.roleId }, params.id, actor.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UserActionDocs('Soft delete a user')
  remove(@Param() params: UserIdParamDto, @CurrentUser() actor: AuthUser): Promise<UserListItem> {
    return this.users.apply({ action: 'delete' }, params.id, actor.id);
  }
}
