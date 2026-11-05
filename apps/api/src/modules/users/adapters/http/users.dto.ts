import {
  accessRequestResponseSchema,
  accessRequestSchema,
  approveUserSchema,
  changeUserRoleSchema,
  userErrorSchema,
  userIdParamSchema,
  userListItemSchema,
  userListQuerySchema,
  userPageSchema,
} from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class AccessRequestDto extends createZodDto(accessRequestSchema) {}

export class AccessRequestResponseDto extends createZodDto(accessRequestResponseSchema) {}

export class UserIdParamDto extends createZodDto(userIdParamSchema) {}

export class UserListQueryDto extends createZodDto(userListQuerySchema) {}

export class ApproveUserDto extends createZodDto(approveUserSchema) {}

export class ChangeUserRoleDto extends createZodDto(changeUserRoleSchema) {}

export class UserListItemDto extends createZodDto(userListItemSchema) {}

export class UserPageDto extends createZodDto(userPageSchema) {}

export class UserErrorDto extends createZodDto(userErrorSchema) {}
