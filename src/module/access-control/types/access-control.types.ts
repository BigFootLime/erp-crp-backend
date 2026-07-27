// Types partagés de la tour de contrôle des accès (#326 / back #200).

export type ModuleAccessOverride = "GRANTED" | "DENIED";
export type ModuleAccessDecision = ModuleAccessOverride | "INHERIT";
export type ModuleAccessSource = "SUPERADMIN" | "OVERRIDE" | "DEFAULT";

export type AccessEventType =
  | "GRANTED"
  | "DENIED"
  | "INHERITED"
  | "DEFAULT_CHANGED"
  | "UNLOCK_ALL";

// Ligne brute de résolution : un module du catalogue vu depuis un compte donné.
export type AccessProfileRow = {
  is_superadmin: boolean;
  module_key: string | null;
  label: string | null;
  nav_page_keys: string[] | null;
  enabled_by_default: boolean | null;
  is_protected: boolean | null;
  is_active: boolean | null;
  access: ModuleAccessOverride | null;
};

export type ResolvedModuleAccess = {
  module_key: string;
  label: string;
  nav_page_keys: string[];
  allowed: boolean;
  source: ModuleAccessSource;
};

export type ResolvedAccessProfile = {
  is_superadmin: boolean;
  modules: ResolvedModuleAccess[];
};

export type OverviewModuleRow = {
  module_key: string;
  label: string;
  description: string | null;
  category: string;
  enabled_by_default: boolean;
  is_protected: boolean;
  sort_order: number;
  denied_count: number;
  granted_count: number;
};

export type OverviewUserRow = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  role: string;
  roles: string[];
  status: string | null;
  is_superadmin: boolean;
  last_login: string | null;
  denied_count: number;
  allowed_count: number;
};

export type OverviewMatrixCell = {
  user_id: number;
  module_key: string;
  access: ModuleAccessOverride | null;
  effective: boolean;
  source: ModuleAccessSource;
};

export type OverviewSummary = {
  users_total: number;
  superadmins: number;
  modules_total: number;
  modules_restricted_by_default: number;
  active_restrictions: number;
};

export type AccessOverview = {
  modules: OverviewModuleRow[];
  users: OverviewUserRow[];
  matrix: OverviewMatrixCell[];
  summary: OverviewSummary;
};

export type AccessEventRow = {
  id: string;
  user_id: number | null;
  username: string | null;
  module_key: string;
  event_type: AccessEventType;
  previous_state: string | null;
  next_state: string | null;
  actor_user_id: number | null;
  actor_username: string | null;
  source: string;
  occurred_at: string;
};

// Contexte d'audit ERP, même forme que les autres modules. Jamais de secret dedans.
export type AccessAuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  client_session_id: string | null;
};
