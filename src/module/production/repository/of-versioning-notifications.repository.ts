import type { PoolClient } from "pg";

import { NOTIFICATION_TOPICS, notificationDedupeKey, resolveNotificationRecipients } from "../../../shared/notifications/routing";
import { enqueueAppNotificationCreated } from "../../../shared/realtime/realtime-outbox.service";
import { repoCreateAppNotifications } from "../../notifications/repository/notifications.repository";
import { readNotificationCandidates, readNotificationRouting } from "./of-versioning.repository";

type Tx = Pick<PoolClient, "query">;

const TITLES: Record<string, string> = {
  [NOTIFICATION_TOPICS.OF_TIME_VARIANCE]: "Dérive de temps : replanification proposée",
  [NOTIFICATION_TOPICS.OF_PLANNING_SUBMITTED]: "Planning soumis à validation",
  [NOTIFICATION_TOPICS.AR_RECALAGE]: "AR client à recaler",
};

/** Notification et outbox appartiennent à la transaction de la décision OF.
 * La clé désigne une décision, pas tout un sujet : deux soumissions différentes
 * préviennent deux fois ; la reprise d'une même soumission ne prévient qu'une fois. */
export async function notifyVersioningTopic(
  tx: Tx,
  topic: string,
  message: string,
  context: { ofId: number; eventId: string }
): Promise<number[]> {
  const [rules, candidates] = await Promise.all([
    readNotificationRouting(topic, tx),
    readNotificationCandidates(tx),
  ]);
  const activeIds = new Set(candidates.map(candidate => candidate.userId));
  const recipients = resolveNotificationRecipients({
    topic,
    rules,
    candidates: candidates.map(candidate => ({
      userId: candidate.userId,
      roles: [candidate.primaryRole, ...candidate.roles].filter((role): role is string => Boolean(role)),
    })),
  }).filter(id => activeIds.has(id));
  if (!recipients.length) return [];

  const notifications = await repoCreateAppNotifications({
    tx,
    user_ids: recipients,
    kind: topic.toLowerCase(),
    title: TITLES[topic] ?? "Notification production",
    message,
    severity: "warning",
    action_url: `/production/of/${context.ofId}`,
    action_label: "Ouvrir",
    action_key: "PREPARE_OF",
    entity_type: "OF",
    entity_id: context.ofId,
    module_key: "production",
    payload: { topic, of_id: context.ofId, decision_id: context.eventId },
    dedupe_key: notificationDedupeKey(topic, context.ofId, context.eventId),
  });
  for (const notification of notifications) {
    await enqueueAppNotificationCreated(tx, notification.user_id, notification, {
      deduplicationKey: `notification:${notification.id}`,
    });
  }
  return recipients;
}
