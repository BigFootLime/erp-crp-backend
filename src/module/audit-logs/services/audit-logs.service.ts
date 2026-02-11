import type { CreateAuditLogBodyDTO, ListAuditLogsQueryDTO } from "../validators/audit-logs.validators";
import * as repo from "../repository/audit-logs.repository";

export async function svcCreateAuditLog(params: {
  user_id: number;
  body: CreateAuditLogBodyDTO;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
}) {
  return repo.repoInsertAuditLog(params);
}

export async function svcListAuditLogs(filters: ListAuditLogsQueryDTO) {
  return repo.repoListAuditLogs(filters);
}
