import { repoListAssignableUsers } from "../repository/users.repository";
import type { AssignableUser } from "../types/users.types";

export function listAssignableUsers(params: {
  q?: string;
  role?: string;
  limit?: number;
  directorySession?:string;
}): Promise<AssignableUser[]> {
  return repoListAssignableUsers(params);
}
