import { PRIMARY_USER_ROLES } from "../domain/roles";

// Retained as the canonical primary-role export for database guards and tests.
// Public account registration is intentionally closed; admin validation lives
// in module/admin/validators/admin.validators.ts.
export const roles = PRIMARY_USER_ROLES;
