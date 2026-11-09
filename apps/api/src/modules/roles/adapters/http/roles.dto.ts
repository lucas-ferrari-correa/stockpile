import {
  createRoleSchema,
  roleErrorSchema,
  roleIdParamSchema,
  roleListSchema,
  roleSchema,
  updateRoleSchema,
} from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class RoleIdParamDto extends createZodDto(roleIdParamSchema) {}

export class CreateRoleDto extends createZodDto(createRoleSchema) {}

export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

export class RoleDto extends createZodDto(roleSchema) {}

export class RoleListDto extends createZodDto(roleListSchema) {}

export class RoleErrorDto extends createZodDto(roleErrorSchema) {}
