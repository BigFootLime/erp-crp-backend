import type { PoolClient } from 'pg';
import { enqueueAppNotificationCreated } from '../../../shared/realtime/realtime-outbox.service';
import { NOTIFICATION_TOPICS, notificationDedupeKey, resolveNotificationRecipients } from '../../../shared/notifications/routing';
import type { NotificationRoutingRule } from '../../../shared/notifications/routing';
import { repoCreateAppNotifications } from '../../notifications/repository/notifications.repository';

type Tx = Pick<PoolClient, 'query'>;
type PlanningRoot = { root_of_id: number; number: string; quantity: string; target_date: string; target_overdue: boolean };

/** Persist the handoff in the generation transaction. Routing is configuration,
 * never a person's name. An explicitly disabled new topic stays disabled; older
 * installations reuse their configured planning recipients until it is set up. */
export async function notifyReplenishmentPlanning(tx: Tx, input: {
  launchId: string; contractId: string; clientId: string; roots: readonly PlanningRoot[];
}): Promise<{ recipients: number; notifications: number }> {
  if (!input.roots.length) return { recipients: 0, notifications: 0 };
  const topic = NOTIFICATION_TOPICS.OF_REPLENISHMENT_CREATED;
  const fallbackTopic = NOTIFICATION_TOPICS.OF_PLANNING_SUBMITTED;
  const routing = await tx.query<{ topic: string; role_key: string | null; user_id: number | null; is_active: boolean }>(
    `SELECT topic,role_key,user_id::int AS user_id,is_active FROM public.notification_routing
     WHERE topic=ANY($1::text[])`, [[topic, fallbackTopic]]);
  const configuredTopic = routing.rows.some(row => row.topic === topic) ? topic : fallbackTopic;
  const rules: NotificationRoutingRule[] = routing.rows.filter(row => row.topic === configuredTopic).map(row => ({
    topic, roleKey: row.role_key, userId: row.user_id, isActive: row.is_active,
  }));
  if (!rules.some(rule => rule.isActive)) return { recipients: 0, notifications: 0 };
  const users = await tx.query<{ user_id: number; primary_role: string | null; roles: string[] }>(
    `SELECT u.id::int AS user_id,u.role AS primary_role,
       COALESCE(ARRAY_AGG(ura.role_key) FILTER (WHERE ura.role_key IS NOT NULL),'{}') AS roles
     FROM public.users u LEFT JOIN public.user_role_assignments ura ON ura.user_id=u.id
     WHERE COALESCE(NULLIF(lower(trim(u.status)),''),'active') NOT IN ('inactive','blocked','suspended')
     GROUP BY u.id,u.role ORDER BY u.id`);
  const candidates = users.rows.map(row => ({ userId: row.user_id,
    roles: [row.primary_role, ...row.roles].filter((role): role is string => role !== null) }));
  const activeUsers = new Set(candidates.map(candidate => candidate.userId));
  const recipients = resolveNotificationRecipients({ topic, rules, candidates }).filter(id => activeUsers.has(id));
  if (!recipients.length) return { recipients: 0, notifications: 0 };
  let notificationCount = 0;
  for (const root of input.roots) {
    const notifications = await repoCreateAppNotifications({ tx, user_ids: recipients,
      kind: 'production.replenishment.created', title: `${root.number} à préparer`,
      message: `${root.quantity} pièces à préparer et planifier. Cible : ${root.target_date}${root.target_overdue ? ' (dépassée)' : ''}.`,
      severity: root.target_overdue ? 'warning' : 'info', action_url: `/production/of/${root.root_of_id}`,
      action_label: 'Ouvrir', action_key: 'PREPARE_OF', entity_type: 'OF', entity_id: root.root_of_id, module_key: 'production',
      payload: { launch_id: input.launchId, contract_id: input.contractId, client_id: input.clientId,
        of_id: root.root_of_id, target_date: root.target_date, target_overdue: root.target_overdue },
      dedupe_key: notificationDedupeKey(topic, input.launchId, root.root_of_id),
    });
    for (const notification of notifications) {
      await enqueueAppNotificationCreated(tx, notification.user_id, notification, {
        deduplicationKey: `notification:${notification.id}`,
      });
    }
    notificationCount += notifications.length;
  }
  return { recipients: recipients.length, notifications: notificationCount };
}
