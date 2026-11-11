import { z } from 'zod';

export const PERMISSIONS = [
  'inventory:read',
  'inventory:write',
  'dashboard:view',
  'imports:manage',
  'users:manage',
  'roles:manage',
  'api-keys:manage-all',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);

export type Permission = z.infer<typeof permissionSchema>;

export const USER_STATUSES = ['PENDING', 'ACTIVE', 'BLOCKED', 'REJECTED', 'DELETED'] as const;

export const userStatusSchema = z.enum(USER_STATUSES);

export type UserStatus = z.infer<typeof userStatusSchema>;

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const USER_NAME_MAX_LENGTH = 120;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export const userNameSchema = z.string().trim().min(1).max(USER_NAME_MAX_LENGTH);

export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const authRoleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type AuthRole = z.infer<typeof authRoleSchema>;

export const authUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  status: userStatusSchema,
  role: authRoleSchema,
  permissions: z.array(permissionSchema),
});

export type AuthUser = z.infer<typeof authUserSchema>;

export const meResponseSchema = authUserSchema;

export type MeResponse = z.infer<typeof meResponseSchema>;

export const updateProfileRequestSchema = z.object({
  name: userNameSchema,
});

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const authErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_PENDING',
  'ACCOUNT_BLOCKED',
  'ACCOUNT_UNAVAILABLE',
  'ACCESS_DENIED',
  'CURRENT_PASSWORD_INVALID',
  'RATE_LIMITED',
]);

export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorSchema = z.object({
  statusCode: z.number().int(),
  code: authErrorCodeSchema,
  message: z.string(),
});

export type AuthError = z.infer<typeof authErrorSchema>;
