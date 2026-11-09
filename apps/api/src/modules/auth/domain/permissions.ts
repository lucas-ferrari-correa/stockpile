import { Permission, permissionSchema } from '@stockpile/shared';

export function toPermissions(values: readonly string[]): Permission[] {
  return values.flatMap((value) => {
    const parsed = permissionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function hasAllPermissions(granted: readonly Permission[], required: readonly Permission[]): boolean {
  return required.every((permission) => granted.includes(permission));
}

export const GOVERNANCE_PERMISSIONS: readonly Permission[] = ['users:manage', 'roles:manage'];

export function holdsGovernance(permissions: readonly Permission[]): boolean {
  return GOVERNANCE_PERMISSIONS.every((permission) => permissions.includes(permission));
}
