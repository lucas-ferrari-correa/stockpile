import { Permission } from '@stockpile/shared';
import { holdsGovernance } from '../../auth/domain/permissions';

export function isImmutableRole(role: { system: boolean }): boolean {
  return role.system;
}

export function dropsGovernance(current: readonly Permission[], next: readonly Permission[]): boolean {
  return holdsGovernance(current) && !holdsGovernance(next);
}
