export const ACCESS_REVIEW_DECISIONS = [
  "CONFIRMED",
  "CHANGE_REQUIRED",
  "EXCEPTION_ACCEPTED",
] as const;

export type AccessReviewDecision = (typeof ACCESS_REVIEW_DECISIONS)[number];
export type AccessReviewRiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type AccessReviewRiskReason =
  | "PRIVILEGED"
  | "INACTIVE"
  | "BLOCKED"
  | "FAILED_LOGIN_BURST"
  | "EXCEPTIONAL_ACCESS";

export type AccessReviewCandidate = {
  user_id: number;
  username: string;
  status: string | null;
  roles: string[];
  is_superadmin: boolean;
  last_activity_at: string | null;
  failed_login_count: number;
  last_failed_login_at: string | null;
  exceptional_module_keys: string[];
  inactive: boolean;
};

export type AccessReviewItem = {
  review_id: string;
  user_id: number;
  username: string;
  status: string | null;
  roles: string[];
  is_superadmin: boolean;
  last_activity_at: string | null;
  failed_login_count: number;
  last_failed_login_at: string | null;
  exceptional_module_keys: string[];
  risk_reasons: AccessReviewRiskReason[];
  risk_level: AccessReviewRiskLevel;
  decision: AccessReviewDecision | null;
  decision_rationale: string | null;
  decided_by: number | null;
  decided_at: string | null;
};

export type AccessReviewHeader = {
  id: string;
  period_start: string;
  period_end: string;
  status: "OPEN" | "CLOSED";
  inactivity_days: number;
  login_failure_window_days: number;
  failed_login_threshold: number;
  due_at: string;
  created_by: number;
  created_at: string;
  closed_by: number | null;
  closed_at: string | null;
};

export type AccessReview = AccessReviewHeader & {
  items: AccessReviewItem[];
  summary: {
    total: number;
    pending: number;
    high_risk: number;
    medium_risk: number;
    privileged: number;
    inactive: number;
    failed_login_bursts: number;
    exceptional_access: number;
  };
};

