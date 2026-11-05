import { z } from 'zod';
import { authRoleSchema, emailSchema, userStatusSchema } from '../auth';

export const ACCESS_REQUEST_ACCEPTED_MESSAGE =
  'If the request can be accepted, an administrator will review it. You will be able to sign in once it is approved.';

export const USER_LIST_DEFAULT_LIMIT = 20;
export const USER_LIST_MAX_LIMIT = 100;

export const accessRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: z.string().min(8).max(72),
});

export type AccessRequest = z.infer<typeof accessRequestSchema>;

export const accessRequestResponseSchema = z.object({
  code: z.literal('ACCESS_REQUESTED'),
  message: z.literal(ACCESS_REQUEST_ACCEPTED_MESSAGE),
});

export type AccessRequestResponse = z.infer<typeof accessRequestResponseSchema>;

export const userIdParamSchema = z.object({
  id: z.uuid(),
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

export const userListQuerySchema = z.object({
  status: userStatusSchema.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(USER_LIST_MAX_LIMIT).default(USER_LIST_DEFAULT_LIMIT),
});

export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const approveUserSchema = z.object({
  roleId: z.uuid(),
});

export type ApproveUser = z.infer<typeof approveUserSchema>;

export const changeUserRoleSchema = z.object({
  roleId: z.uuid(),
});

export type ChangeUserRole = z.infer<typeof changeUserRoleSchema>;

export const userListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  status: userStatusSchema,
  role: authRoleSchema.nullable(),
  createdAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  reRequestOfDeleted: z.boolean(),
});

export type UserListItem = z.infer<typeof userListItemSchema>;

export const userPageSchema = z.object({
  items: z.array(userListItemSchema),
  nextCursor: z.uuid().nullable(),
});

export type UserPage = z.infer<typeof userPageSchema>;

export const userErrorCodeSchema = z.enum([
  'USER_NOT_FOUND',
  'ROLE_NOT_FOUND',
  'INVALID_CURSOR',
  'INVALID_TRANSITION',
  'SELF_ACTION_FORBIDDEN',
  'LAST_ADMIN_PROTECTED',
]);

export type UserErrorCode = z.infer<typeof userErrorCodeSchema>;

export const userErrorSchema = z.object({
  statusCode: z.number().int(),
  code: userErrorCodeSchema,
  message: z.string(),
});

export type UserError = z.infer<typeof userErrorSchema>;
