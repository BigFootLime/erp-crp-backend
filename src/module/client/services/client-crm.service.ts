import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { AuditContext } from "../repository/client.repository";
import * as repo from "../repository/client-crm.repository";
import type { CrmCommand, CrmDetailQuery, CrmFollowupQuery } from "../validators/client-crm.validators";
import type { CrmCommandResult, CrmProfile } from "../types/client-crm.types";

function requireClient(client: repo.CrmClientState | null): asserts client is repo.CrmClientState {
  if (!client) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable");
}
function requireActiveClient(client: repo.CrmClientState) {
  if (client.status === "inactif" || client.blocked || client.archived_at) {
    throw new HttpError(409, "CRM_CLIENT_INACTIVE", "Cette fiche est inactive ou bloquée : aucune nouvelle relance");
  }
}
function requireVersion(actual: number, expected: number) {
  if (actual !== expected) throw new HttpError(409, "CRM_VERSION_CONFLICT", "Le suivi a changé. Actualisez avant d’enregistrer.");
}
function requireChannel(profile: CrmProfile, channel: string) {
  if (channel === "INTERNAL") return;
  if (profile.contact_policy === "DO_NOT_CONTACT" || (channel === "EMAIL" && profile.contact_policy !== "ALLOWED")) {
    throw new HttpError(409, "CRM_CONTACT_RESTRICTED", "Le canal est interdit ou reste à qualifier dans le suivi commercial");
  }
}
async function requireOwner(tx: PoolClient, id: number | null) {
  if (id !== null && !await repo.activeCrmOwner(tx, id)) {
    throw new HttpError(422, "CRM_OWNER_INACTIVE", "Choisissez un responsable actif");
  }
}
async function requireContact(tx: PoolClient, clientId: string, id: string | null) {
  if (id && !await repo.activeCrmContact(tx, clientId, id)) {
    throw new HttpError(422, "CRM_CONTACT_NOT_OF_CLIENT", "Choisissez un contact actif de cette fiche");
  }
}
function requireFuture(value: string) {
  if (Date.parse(value) < Date.now() - 60000) {
    throw new HttpError(422, "CRM_DUE_DATE_PAST", "Choisissez une échéance à venir");
  }
}

export async function getClientCrm(clientId: string, query: CrmDetailQuery) {
  const client = await repo.readCrmClient(pool, clientId);
  requireClient(client);
  // Fixed query count; no per-interaction/contact/owner SQL loop.
  const [profile, owners, followups, history] = await Promise.all([
    repo.readCrmProfile(pool, clientId), repo.listCrmOwners(pool),
    repo.listClientCrmFollowups(pool, clientId, query.followup_page), repo.listClientCrmEvents(pool, clientId, query.history_page),
  ]);
  return { profile, owners, followups, history,
    client_active: client.status !== "inactif" && !client.blocked && !client.archived_at };
}
export async function getCrmFollowups(query: CrmFollowupQuery) {
  return repo.listDueCrmFollowups(pool, query);
}

/** Parent-client locking serializes contact/archive and CRM decisions. Events,
 * versioned state, audit and realtime are committed together. No external send. */
export async function executeCrmCommand(clientId: string, command: CrmCommand, key: string, audit: AuditContext) {
  const hash = createHash("sha256").update(JSON.stringify({ client_id: clientId, command })).digest("hex");
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await repo.lockCrmIdempotency(tx, audit.user_id, key);
    const client = await repo.readCrmClient(tx, clientId, true);
    requireClient(client);
    const replay = await repo.readCrmReplay(tx, audit.user_id, key);
    if (replay) {
      if (replay.request_hash !== hash) throw new HttpError(409, "CRM_IDEMPOTENCY_CONFLICT", "Cette tentative correspond à une autre action");
      return { result: replay.response_json, replayed: true };
    }
    const profile = await repo.readCrmProfile(tx, clientId, true);
    const eventId = randomUUID();
    let result: CrmCommandResult = { event_id: eventId };
    let details: Record<string, unknown> = {};
    let followupId: string | null = null;

    if (command.action === "QUALIFY") {
      requireVersion(profile.version, command.expected_version);
      await requireOwner(tx, command.owner_user_id);
      const after = await repo.saveCrmProfile(tx, clientId, audit.user_id, command);
      result = { ...result, profile: after };
      details = { before: profile, after };
    } else if (command.action === "PLAN") {
      requireActiveClient(client);
      requireVersion(profile.version, command.expected_profile_version);
      requireChannel(profile, command.channel);
      requireFuture(command.due_at);
      await requireOwner(tx, command.owner_user_id);
      await requireContact(tx, clientId, command.contact_id);
      const followup = await repo.createCrmFollowup(tx, clientId, audit.user_id, command);
      if (!followup) throw new Error("CRM_FOLLOWUP_INSERT_NOT_VISIBLE");
      result = { ...result, followup };
      followupId = followup.id;
      details = { due_at: followup.due_at, owner_user_id: followup.owner_user_id, contact_id: followup.contact_id,
        channel: followup.channel, purpose: followup.purpose, title: followup.title };
    } else if (command.action === "LOG_INTERACTION") {
      // This records an exchange that already happened; contact restrictions
      // do not prevent recording evidence or historical opt-out requests.
      await requireContact(tx, clientId, command.contact_id);
      if (Date.parse(command.occurred_at) > Date.now() + 300000) {
        throw new HttpError(422, "CRM_INTERACTION_FUTURE", "Un échange doit avoir déjà eu lieu");
      }
      details = { contact_id: command.contact_id, channel: command.channel, outcome: command.outcome,
        interaction_at: command.occurred_at, note: command.note };
    } else {
      const before = await repo.readCrmFollowup(tx, clientId, command.followup_id, true);
      if (!before) throw new HttpError(404, "CRM_FOLLOWUP_NOT_FOUND", "Relance introuvable dans cette fiche");
      requireVersion(before.version, command.expected_version);
      if (before.status !== "PLANNED") throw new HttpError(409, "CRM_FOLLOWUP_CLOSED", "Cette relance est déjà clôturée");
      if (command.action === "RESCHEDULE") {
        requireActiveClient(client);
        requireChannel(profile, before.channel);
        requireFuture(command.due_at);
        await requireOwner(tx, command.owner_user_id);
        await requireContact(tx, clientId, before.contact_id);
      }
      const after = await repo.changeCrmFollowup(tx, clientId, command);
      if (!after) throw new Error("CRM_FOLLOWUP_UPDATE_NOT_VISIBLE");
      result = { ...result, followup: after };
      followupId = after.id;
      details = { previous_due_at: before.due_at, due_at: after.due_at, previous_owner_user_id: before.owner_user_id,
        owner_user_id: after.owner_user_id, previous_version: before.version, version: after.version,
        status: after.status, outcome: after.outcome,
        reason: command.action === "RESCHEDULE" ? command.reason : command.action === "CANCEL" ? command.reason : null,
        note: command.action === "CANCEL" ? null : command.note };
    }
    await repo.appendCrmEvent(tx, { id: eventId, clientId, followupId, action: command.action,
      actor: audit.user_id, key, hash, details, result });
    await repoInsertAuditLog({ user_id: audit.user_id, tx, ip: audit.ip, user_agent: audit.user_agent,
      device_type: audit.device_type, os: audit.os, browser: audit.browser,
      body: { event_type: "ACTION", action: `CLIENT_CRM_${command.action}`, entity_type: "client", entity_id: clientId,
        page_key: audit.page_key, path: audit.path, client_session_id: audit.client_session_id,
        details: { event_id: eventId, followup_id: followupId } } });
    await enqueueEntityChanged(tx, { module: "clients", entityType: "client", entityId: clientId, action: "updated",
      at: new Date().toISOString(), invalidateKeys: ["clients", `client:${clientId}`, "client-crm-followups"] },
    { deduplicationKey: `client-crm:${eventId}` });
    return { result, replayed: false };
  }, { reconcileCommit: async verifier => {
    const saved = await repo.readCrmReplay(verifier, audit.user_id, key);
    return !saved ? "not_committed" : saved.request_hash === hash ? "committed" : "unknown";
  } });
}
