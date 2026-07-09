// Module « Temps & Déplacements » — T2 backend pointage. Types du domaine.
// hr_time_events est append-only : jamais d'UPDATE/DELETE (corrections via hr_time_adjustments, T4).

export type HrEventType = "IN" | "OUT" | "BREAK_START" | "BREAK_END" | "MISSION_START" | "MISSION_END";
export type HrEventSource = "BADGE" | "WEB" | "MOBILE" | "ADMIN" | "IMPORT";
export type HrAnomalyType =
  | "MISSING_IN"
  | "MISSING_OUT"
  | "MISSING_BREAK_END"
  | "DOUBLE_BADGE"
  | "TOO_LONG_DAY"
  | "TOO_SHORT_BREAK"
  | "OUTSIDE_SCHEDULE";
export type HrAnomalySeverity = "INFO" | "WARNING" | "CRITICAL";

export interface HrEmployeeLite {
  id: string;
  user_id: number;
  matricule: string;
  service: string | null;
  manager_user_id: number | null;
  status: "ACTIVE" | "SUSPENDED" | "LEFT";
}

export interface HrTimeEvent {
  id: string;
  employee_id: string;
  device_id: string | null;
  event_type: HrEventType;
  event_time: string;
  source: HrEventSource;
  created_at: string;
}

export interface HrTimeAnomaly {
  id: string;
  employee_id: string;
  date: string;
  anomaly_type: HrAnomalyType;
  severity: HrAnomalySeverity;
  message: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  created_at: string;
}

// Relevé journalier calculé à partir des événements bruts (jamais persisté comme source de vérité :
// les événements le sont ; ceci est un agrégat recalculable — hr_work_sessions / hr_timesheet_days).
export interface HrDailyTimesheet {
  employee_id: string;
  date: string;
  first_in: string | null;
  last_out: string | null;
  break_minutes: number;
  worked_minutes: number;
  expected_minutes: number;
  overtime_minutes: number;
  missing_minutes: number;
  status: "OK" | "ANOMALY" | "MANUAL_REVIEW" | "VALIDATED";
  anomalies: HrTimeAnomaly[];
}

export interface HrWeeklyTimesheet {
  employee_id: string;
  week_start: string;
  week_end: string;
  worked_minutes: number;
  contract_minutes: number;
  overtime_minutes: number;
  absence_minutes: number;
  days: HrDailyTimesheet[];
}

export interface CreateTimeEventInput {
  employee_id: string;
  event_type: HrEventType;
  event_time?: string;
  source: HrEventSource;
  device_id?: string | null;
  idempotency_key?: string | null;
  raw_payload?: Record<string, unknown>;
}

export interface CreateTimeEventResult {
  event: HrTimeEvent;
  deduplicated: boolean; // true si idempotency_key déjà vu (aucune nouvelle ligne)
  double_badge: boolean; // true si double badge rapproché détecté (anomalie enregistrée)
}
