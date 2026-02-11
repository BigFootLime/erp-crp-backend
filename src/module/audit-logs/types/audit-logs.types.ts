export type AuditEventType = "NAVIGATION" | "ACTION";

export type AuditLogRow = {
  id: string;
  created_at: string;
  user_id: number;
  username: string | null;
  role: string | null;
  event_type: AuditEventType;
  action: string;
  page_key: string | null;
  entity_type: string | null;
  entity_id: string | null;
  path: string | null;
  client_session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  details: unknown;
};

export type Paginated<T> = {
  items: T[];
  total: number;
};
