import type { CreateRole, Role, RoleList, UpdateRole } from '@stockpile/shared';
import type { HttpClient } from '../http';

export interface RoleRequestOptions {
  signal?: AbortSignal;
}

function rolePath(id: string): string {
  return `/roles/${encodeURIComponent(id)}`;
}

export function listRoles(http: HttpClient, options: RoleRequestOptions = {}): Promise<RoleList> {
  return http.get<RoleList>('/roles', options);
}

export function getRole(http: HttpClient, id: string, options: RoleRequestOptions = {}): Promise<Role> {
  return http.get<Role>(rolePath(id), options);
}

export function createRole(http: HttpClient, body: CreateRole, options: RoleRequestOptions = {}): Promise<Role> {
  return http.post<Role>('/roles', body, options);
}

export function updateRole(
  http: HttpClient,
  id: string,
  body: UpdateRole,
  options: RoleRequestOptions = {},
): Promise<Role> {
  return http.request<Role>(rolePath(id), { ...options, method: 'PATCH', body });
}

export function deleteRole(http: HttpClient, id: string, options: RoleRequestOptions = {}): Promise<void> {
  return http.request<void>(rolePath(id), { ...options, method: 'DELETE' });
}
