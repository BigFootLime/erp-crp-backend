import type { PoolClient } from "pg";
import { NOTIFICATION_TOPICS, notificationDedupeKey, resolveNotificationRecipients } from "../../../shared/notifications/routing";
import { enqueueAppNotificationCreated } from "../../../shared/realtime/realtime-outbox.service";
import { repoCreateAppNotifications } from "../../notifications/repository/notifications.repository";
import { readNotificationCandidates, readNotificationRouting } from "../../production/repository/of-versioning.repository";
import { demandReceivedEmailEnabled } from "./demand-received-email.worker";

type Deposit = {
  id: string;
  clientId: string;
  site: string;
  lineCount: number;
  source: "carco" | "demand";
};

export async function notifyDemandReceived(tx: PoolClient, deposit: Deposit) {
  const topic = NOTIFICATION_TOPICS.CLIENT_DEMAND_RECEIVED;
  const rules = await readNotificationRouting(topic, tx);
  if (!rules.length) return;

  const candidates = (await readNotificationCandidates(tx)).map(candidate => ({
    userId: candidate.userId,
    roles: [candidate.primaryRole, ...candidate.roles].filter((role): role is string => Boolean(role)),
  }));
  const activeIds = new Set(candidates.map(candidate => candidate.userId));
  const recipients = resolveNotificationRecipients({ topic, rules, candidates }).filter(id => activeIds.has(id));
  if (!recipients.length) return;

  const params = new URLSearchParams({ view: "adv" });
  if (deposit.source === "carco") {
    params.set("carco_client", deposit.clientId);
    params.set("carco_site", deposit.site);
  } else {
    params.set("demand_client", deposit.clientId);
  }
  const notifications = await repoCreateAppNotifications({
    tx,
    user_ids: recipients,
    kind: "commercial.client-demand.received",
    title: "Nouvelles échéances client à examiner",
    message: `${deposit.lineCount} échéance(s) transmise(s) par le client ${deposit.clientId}.`,
    severity: "info",
    action_url: "/commandes?" + params.toString(),
    action_label: "Examiner les échéances",
    entity_type: "CLIENT_DEMAND_DEPOSIT",
    entity_id: deposit.id,
    module_key: "commandes-clients",
    payload: { topic, client_id: deposit.clientId, deposit_id: deposit.id },
    dedupe_key: notificationDedupeKey(topic, deposit.source, deposit.id),
  });
  if (notifications.length && demandReceivedEmailEnabled()) {
    await tx.query(
      `INSERT INTO public.client_demand_notification_emails (notification_id)
       SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
      [notifications.map(notification => notification.id)],
    );
  }
  for (const notification of notifications) {
    await enqueueAppNotificationCreated(tx, notification.user_id, notification, {
      deduplicationKey: "notification:" + notification.id,
    });
  }
}
