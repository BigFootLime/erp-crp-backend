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
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
};

export type AppNotificationsList = {
  items: AppNotification[];
  total: number;
  unread_total: number;
};
