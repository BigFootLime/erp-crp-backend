import type { AuditContext } from "../../methodes/types/methodes.types";

export type ProductionReadinessCapabilities = {
  view: boolean;
  calendar_write: boolean;
  cost_center_write: boolean;
  rate_write: boolean;
};

export type ProductionPrerequisiteDTO = {
  code: string;
  ready: boolean;
  definition: string;
  unit: string;
  period_start: string | null;
  period_end: string | null;
  source: string;
  freshness_at: string | null;
  reliability: string;
  actual_value: Record<string, unknown> | unknown[] | null;
  expected_value: string;
  remediation: string;
  action_path: string;
  action_label: string;
  can_manage: boolean;
};

export type ProductionReadinessDTO = {
  flow: "PRODUCTION";
  ready: boolean;
  checked_at: string;
  capabilities: ProductionReadinessCapabilities;
  prerequisites: ProductionPrerequisiteDTO[];
};

export type ProductionCalendarClosureDTO = {
  id: string;
  start_date: string;
  end_date: string;
  reason: string;
  created_at: string;
  created_by: number | null;
};

export type ProductionCalendarDTO = {
  id: string;
  code: string;
  label: string;
  timezone: string;
  working_days: number[];
  day_start: string;
  day_end: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
  closures: ProductionCalendarClosureDTO[];
};

export type ProductionReadinessAuditContext = AuditContext;
