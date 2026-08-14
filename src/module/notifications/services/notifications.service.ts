import type { AppNotification, AppNotificationsList } from "../types/notifications.types";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { ListNotificationsQueryDTO } from "../validators/notifications.validators";
import type { AccessAuditContext } from "../../access-control/types/access-control.types";
import { resolveModuleKeyForPath } from "../../access-control/domain/module-catalog";
import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  repoListAppNotifications,
  repoMarkAllAppNotificationsRead,
  repoMarkAppNotificationRead,
  repoEscalateNotification,
  repoGetNotificationForUpdate,
  repoMuteNotification,
  withNotificationTransaction,
} from "../repository/notifications.repository";

export async function svcListAppNotifications(params: {
  user_id: number;
  query: ListNotificationsQueryDTO;
}): Promise<AppNotificationsList> {
  const result = await repoListAppNotifications({
    user_id: params.user_id,
    unread_only: params.query.unread_only,
    include_muted: params.query.include_muted,
    include_expired: params.query.include_expired,
    limit: params.query.limit,
  });
  const profile = await resolveAccessProfile(params.user_id);
  if (profile === null) {
    result.items = result.items.map((item) => item.action_url === null ? item : {
      ...item,
      action_url: null,
      action_label: null,
      action_available: false,
      action_unavailable_reason: "ACCESS_UNAVAILABLE" as const,
    });
    return result;
  }
  if (profile.is_superadmin) return result;
  const allowedByModule = new Map(profile.modules.map((entry) => [entry.module_key, entry.allowed]));
  result.items = result.items.map((item) => {
    const moduleKey = item.module_key ?? resolveModuleKeyForPath(item.action_url ?? undefined);
    if (item.action_url && !moduleKey) {
      return {
        ...item,
        action_url: null,
        action_label: null,
        action_available: false,
        action_unavailable_reason: "ACCESS_UNAVAILABLE" as const,
      };
    }
    if (moduleKey && allowedByModule.get(moduleKey) !== true) {
      return {
        ...item,
        action_url: null,
        action_label: null,
        action_available: false,
        action_unavailable_reason: "FORBIDDEN" as const,
      };
    }
    if (item.state === "EXPIRED") {
      return {
        ...item,
        action_url: null,
        action_label: null,
        action_available: false,
        action_unavailable_reason: "EXPIRED" as const,
      };
    }
    return item;
  });
  return result;
}

export async function svcMarkAppNotificationRead(params: {
  user_id: number;
  notification_id: string;
}): Promise<AppNotification | null> {
  return repoMarkAppNotificationRead({
    user_id: params.user_id,
    notification_id: params.notification_id,
    read_by: params.user_id,
  });
}

export async function svcMarkAllAppNotificationsRead(params: { user_id: number }): Promise<{ updated: number }> {
  return repoMarkAllAppNotificationsRead({
    user_id: params.user_id,
    read_by: params.user_id,
  });
}

async function auditNotificationState(
  tx: PoolClient,
  context: AccessAuditContext,
  action: string,
  notificationId: string,
  details: Record<string, unknown>
) {
  await repoInsertAuditLog({
    user_id: context.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: "notifications",
      entity_type: "app_notification",
      entity_id: notificationId,
      path: context.path,
      client_session_id: context.client_session_id,
      details,
    },
    ip: context.ip,
    user_agent: context.user_agent,
    device_type: context.device_type,
    os: context.os,
    browser: context.browser,
    tx,
  });
}

export async function svcMuteAppNotification(params: {
  user_id: number;
  notification_id: string;
  muted_until: string;
  audit: AccessAuditContext;
}): Promise<AppNotification> {
  const until = new Date(params.muted_until);
  const now = Date.now();
  if (!Number.isFinite(until.getTime()) || until.getTime() <= now || until.getTime() > now + 30 * 86_400_000) {
    throw new HttpError(
      400,
      "NOTIFICATION_MUTE_WINDOW_INVALID",
      "La mise en sourdine doit se terminer dans les 30 prochains jours."
    );
  }
  return withNotificationTransaction(async (tx) => {
    const current = await repoGetNotificationForUpdate(tx, params);
    if (!current) {
      throw new HttpError(404, "NOTIFICATION_NOT_FOUND", "Notification introuvable.");
    }
    const updated = await repoMuteNotification(tx, params);
    await auditNotificationState(tx, params.audit, "NOTIFICATION_MUTED", params.notification_id, {
      muted_until: params.muted_until,
      entity_type: current.entity_type,
      entity_id: current.entity_id,
    });
    return updated!;
  });
}

export async function svcEscalateAppNotification(params: {
  user_id: number;
  notification_id: string;
  level: number;
  audit: AccessAuditContext;
}): Promise<AppNotification> {
  return withNotificationTransaction(async (tx) => {
    const current = await repoGetNotificationForUpdate(tx, params);
    if (!current) {
      throw new HttpError(404, "NOTIFICATION_NOT_FOUND", "Notification introuvable.");
    }
    const updated = await repoEscalateNotification(tx, params);
    if (params.level > current.escalation_level) {
      await auditNotificationState(tx, params.audit, "NOTIFICATION_ESCALATED", params.notification_id, {
        previous_level: current.escalation_level,
        next_level: params.level,
        entity_type: current.entity_type,
        entity_id: current.entity_id,
      });
    }
    return updated!;
  });
}
