export type AppNotificationSeverity = "info" | "success" | "warning" | "error";

export type AppNotification = {
  id: string;
  user_id: number;
  kind: string;
  title: string;
  message: string;
  severity: AppNotificationSeverity;
  action_url: string | null;
  action_label: string | null;
  action_key: string | null;
  action_available: boolean;
  action_unavailable_reason: "FORBIDDEN" | "EXPIRED" | "ACCESS_UNAVAILABLE" | null;
  entity_type: string | null;
  entity_id: string | null;
  module_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  expires_at: string | null;
  muted_until: string | null;
  escalated_at: string | null;
  escalation_level: number;
  state: "ACTIVE" | "READ" | "MUTED" | "EXPIRED";
};

export type AppNotificationsList = {
  items: AppNotification[];
  total: number;
  unread_total: number;
  muted_total: number;
  expired_total: number;
};
