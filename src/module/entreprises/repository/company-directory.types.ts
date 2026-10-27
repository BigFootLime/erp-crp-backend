export type DirectoryAuditActor = Readonly<{
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
}>;
export type BusinessCompanyInput = Readonly<{
  company_id: string;
  code: string;
  name: string;
  profile: "COMMERCIAL" | "INDUSTRIAL";
  status: "ACTIVE" | "SUSPENDED" | "RETIRED";
  enabled_module_keys: readonly string[];
  enabled_commercial_projection_capabilities: readonly string[];
}>;
export type MembershipInput = Readonly<{
  company_id: string;
  profile_id: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  allowed_module_keys: readonly string[];
  denied_module_keys: readonly string[];
  enabled_commercial_projection_capabilities: readonly string[];
  /** Zero creates a new membership; a positive value updates that exact version. */
  expected_version: number;
}>;
export type CompanyInstanceInput = Readonly<{
  company_id: string;
  environment: "cerp_prod" | "cerp_test";
  site_id: string;
  active: boolean;
  expected_version: number;
}>;
export type CompanySiteAdministrativeLevelInput = Readonly<{
  company_id: string;
  profile_id: string;
  environment: "cerp_prod" | "cerp_test";
  is_superadmin: boolean;
  expected_version: number;
}>;
export type CompanySiteAdministrativeLevel = Readonly<{
  company_id: string;
  profile_id: string;
  environment: "cerp_prod" | "cerp_test";
  site_id: string;
  is_superadmin: boolean;
  status: string;
  version: number;
}>;
export type CompanyContextRecord = Readonly<{
  company_id: string;
  code: string;
  name: string;
  profile: "COMMERCIAL" | "INDUSTRIAL";
  company_status: string;
  enabled_module_keys: string[];
  company_projection_capabilities: string[];
  membership_status: string;
  allowed_module_keys: string[];
  denied_module_keys: string[];
  membership_projection_capabilities: string[];
  profile_id: string;
  central_account_id: number;
  environment: "cerp_prod" | "cerp_test";
  site_id: string;
  instance_active: boolean;
}>;
