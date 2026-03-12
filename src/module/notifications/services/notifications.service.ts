import type { AppNotification, AppNotificationsList } from "../types/notifications.types";
import type { ListNotificationsQueryDTO } from "../validators/notifications.validators";
import {
  repoListAppNotifications,
  repoMarkAllAppNotificationsRead,
  repoMarkAppNotificationRead,
} from "../repository/notifications.repository";

export async function svcListAppNotifications(params: {
  user_id: number;
  query: ListNotificationsQueryDTO;
}): Promise<AppNotificationsList> {
  return repoListAppNotifications({
    user_id: params.user_id,
    unread_only: params.query.unread_only,
    limit: params.query.limit,
  });
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
