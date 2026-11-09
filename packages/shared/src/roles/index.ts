import { z } from 'zod';
import { permissionSchema } from '../auth';

export const ROLE_NAME_MAX_LENGTH = 64;

export const roleNameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH);

export const rolePermissionsSchema = z
  .array(permissionSchema)
  .refine((permissions) => new Set(permissions).size === permissions.length, {
    message: 'Permissions must not contain duplicates',
  });

export const roleIdParamSchema = z.object({
  id: z.uuid(),
});

export type RoleIdParam = z.infer<typeof roleIdParamSchema>;

export const createRoleSchema = z.object({
  name: roleNameSchema,
  permissions: rolePermissionsSchema,
});

export type CreateRole = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    permissions: rolePermissionsSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'Provide name, permissions or both',
  });

export type UpdateRole = z.infer<typeof updateRoleSchema>;

export const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  system: z.boolean(),
  permissions: z.array(permissionSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Role = z.infer<typeof roleSchema>;

export const roleListItemSchema = roleSchema.extend({
  userCount: z.number().int().nonnegative(),
});

export type RoleListItem = z.infer<typeof roleListItemSchema>;

export const roleListSchema = z.object({
  items: z.array(roleListItemSchema),
});

export type RoleList = z.infer<typeof roleListSchema>;

export const roleErrorCodeSchema = z.enum([
  'ROLE_NOT_FOUND',
  'ROLE_NAME_TAKEN',
  'ROLE_IN_USE',
  'SYSTEM_ROLE_IMMUTABLE',
  'LAST_ADMIN_PROTECTED',
]);

export type RoleErrorCode = z.infer<typeof roleErrorCodeSchema>;

export const roleErrorSchema = z.object({
  statusCode: z.number().int(),
  code: roleErrorCodeSchema,
  message: z.string(),
  userCount: z.number().int().nonnegative().optional(),
});

export type RoleError = z.infer<typeof roleErrorSchema>;
