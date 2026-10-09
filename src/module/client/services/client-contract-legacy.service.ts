import { createHash, randomUUID } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { assertDeliveryContractBoundary } from "../../livraisons/repository/delivery-contract-boundary.repository";
import { mapLegacyContractLines } from "../domain/client-contract-legacy";
import { readCrmClient } from "../repository/client-crm.repository";
import { readClientContract } from "../repository/client-contract.repository";
import * as legacy from "../repository/client-contract-legacy.repository";
import type { AuditContext } from "../repository/client.repository";
import type { LegacyContractBindCommand } from "../validators/client-contract-legacy.validators";

export async function getLegacyContractOrders(clientId: string, contractId: string, page: number) {
  if (!await readClientContract(pool, clientId, contractId)) {
    throw new HttpError(404, "CLIENT_CONTRACT_NOT_FOUND", "Contrat introuvable pour ce client");
  }
  return legacy.listLegacyOrderCandidates(pool, clientId, contractId, page);
}

export async function getLegacyContractPreview(clientId: string, contractId: string, orderId: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const contract = await readClientContract(db, clientId, contractId);
    if (!contract) throw new HttpError(404, "CLIENT_CONTRACT_NOT_FOUND", "Contrat introuvable pour ce client");
    const source = await legacy.readLegacyOrderSnapshot(db, clientId, orderId);
    if (!source || source.snapshot.order_type !== "CADRE") {
      throw new HttpError(404, "LEGACY_CADRE_NOT_FOUND", "Cadre historique introuvable pour ce client");
    }
    const association = await legacy.readLegacyAssociation(db, orderId);
    const recordedSource = association ? await legacy.readRecordedLegacySource(db, orderId) : null;
    const match = mapLegacyContractLines(contract, source.snapshot.lines);
    const issues = [...match.issues];
    const client = await readCrmClient(db, clientId);
    if (!client || client.archived_at || client.blocked || client.status === "inactif") {
      issues.push({ line_id: null, code: "LEGACY_CONTRACT_CLIENT_INACTIVE", message: "Le client est inactif ou bloqué." });
    }
    if (contract.status !== "ACTIVE") issues.push({ line_id: null, code: "CLIENT_CONTRACT_INACTIVE", message: "Le contrat doit être actif pour une reprise." });
    if (association) issues.push({ line_id: null, code: "LEGACY_ALREADY_ASSOCIATED", message: "Ce cadre possède déjà une association historique." });
    if (await legacy.hasFirmContractCall(db, orderId)) issues.push({ line_id: null, code: "LEGACY_FIRM_CALL_CONFLICT", message: "Cette commande est déjà un appel ferme de contrat." });
    await db.query("COMMIT");
    return { source: source.snapshot, source_hash: source.source_hash, contract_version: contract.version,
      mappings: match.mappings, issues, association, recorded_source: recordedSource, eligible: issues.length === 0 };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

/** Used only for pending BL preflight; shipped evidence and PDFs are never rewritten. */
export const LEGACY_PENDING_DELIVERIES_SQL = `
WITH related AS (
  SELECT id FROM public.bon_livraison WHERE commande_id=$1::bigint
  UNION SELECT line.bon_livraison_id FROM public.bon_livraison_ligne line
    JOIN public.commande_ligne source ON source.id=line.commande_ligne_id WHERE source.commande_id=$1::bigint
  UNION SELECT line.bon_livraison_id FROM public.bon_livraison_ligne_allocations allocation
    JOIN public.bon_livraison_ligne line ON line.id=allocation.bon_livraison_ligne_id
    JOIN public.commande_ligne_affaire_allocation source ON source.id=allocation.commande_ligne_affaire_allocation_id
    WHERE source.commande_id=$1::bigint
  UNION SELECT line.bon_livraison_id FROM public.bon_livraison_ligne_allocations allocation
    JOIN public.bon_livraison_ligne line ON line.id=allocation.bon_livraison_ligne_id
    JOIN public.stock_reservations reservation ON reservation.id=allocation.reservation_id
    JOIN public.commande_ligne_affaire_allocation source ON source.id=reservation.commande_ligne_affaire_allocation_id
    WHERE source.commande_id=$1::bigint
)
SELECT delivery.id::text,delivery.numero FROM related
JOIN public.bon_livraison delivery ON delivery.id=related.id
WHERE delivery.statut IN('DRAFT','READY') ORDER BY delivery.id
`;

export async function bindLegacyContractOrder(clientId: string, contractId: string,
  command: LegacyContractBindCommand, key: string, audit: AuditContext) {
  const hash = createHash("sha256").update(JSON.stringify({ client_id: clientId, contract_id: contractId, command })).digest("hex");
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`legacy-contract:${audit.user_id}:${key}`]);
    const replay = await legacy.readLegacyAssociationReplay(tx, audit.user_id, key);
    if (replay) {
      if (replay.request_hash !== hash) throw new HttpError(409, "LEGACY_CONTRACT_KEY_CONFLICT", "Cette tentative correspond à une autre reprise");
      const { request_hash: _hash, ...association } = replay;
      return { association, replayed: true };
    }
    const client = await readCrmClient(tx, clientId, true);
    if (!client) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable");
    if (client.archived_at || client.blocked || client.status === "inactif") {
      throw new HttpError(409, "LEGACY_CONTRACT_CLIENT_INACTIVE", "Le client est inactif ou bloqué");
    }
    const contract = await readClientContract(tx, clientId, contractId, true);
    if (!contract) throw new HttpError(404, "CLIENT_CONTRACT_NOT_FOUND", "Contrat introuvable pour ce client");
    if (contract.status !== "ACTIVE" || contract.version !== command.expected_contract_version) {
      throw new HttpError(409, "LEGACY_CONTRACT_VERSION_CONFLICT", "Actualisez la définition active du contrat");
    }
    if (!await legacy.lockLegacyOrderSource(tx, clientId, command.commande_id)) {
      throw new HttpError(404, "LEGACY_CADRE_NOT_FOUND", "Cadre historique introuvable pour ce client");
    }
    const source = await legacy.readLegacyOrderSnapshot(tx, clientId, command.commande_id);
    if (!source || source.snapshot.order_type !== "CADRE") {
      throw new HttpError(409, "LEGACY_CADRE_REQUIRED", "La reprise concerne seulement un ancien cadre");
    }
    if (source.source_hash !== command.expected_source_hash) {
      throw new HttpError(409, "LEGACY_CONTRACT_SOURCE_CHANGED", "Le cadre a changé. Actualisez la prévisualisation.");
    }
    if (await legacy.readLegacyAssociation(tx, command.commande_id)) {
      throw new HttpError(409, "LEGACY_ALREADY_ASSOCIATED", "Ce cadre est déjà associé à un contrat");
    }
    if (await legacy.hasFirmContractCall(tx, command.commande_id)) {
      throw new HttpError(409, "LEGACY_FIRM_CALL_CONFLICT", "Cette commande est déjà un appel ferme de contrat");
    }
    const match = mapLegacyContractLines(contract, source.snapshot.lines);
    if (match.issues.length) throw new HttpError(422, "LEGACY_CONTRACT_MAPPING_INVALID", "La définition historique ne correspond pas au contrat", { issues: match.issues });
    // Acquire after canonical source locks: an in-flight BL can finish its
    // parent FK checks before the rare association command excludes BL guards.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('delivery-contract-binding',0))");
    const association = await legacy.insertLegacyAssociation(tx, { id: randomUUID(), contract, source: source.snapshot,
      sourceHash: source.source_hash, mappings: match.mappings, actor: audit.user_id, key, requestHash: hash, reason: command.reason });
    const pending = (await tx.query<{ id: string; numero: string }>(LEGACY_PENDING_DELIVERIES_SQL, [command.commande_id])).rows;
    for (const delivery of pending) {
      try { await assertDeliveryContractBoundary(tx, delivery.id); }
      catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          throw new HttpError(409, "LEGACY_CONTRACT_DELIVERY_CONFLICT", `Le BL ${delivery.numero} doit être séparé avant cette reprise`);
        }
        throw error;
      }
    }
    await repoInsertAuditLog({ tx, user_id: audit.user_id, ip: audit.ip, user_agent: audit.user_agent,
      device_type: audit.device_type, os: audit.os, browser: audit.browser,
      body: { event_type: "ACTION", action: "CLIENT_CONTRACT_LEGACY_ASSOCIATED", entity_type: "client", entity_id: clientId,
        page_key: "clients.contracts.legacy", path: audit.path, client_session_id: audit.client_session_id,
        details: { association_id: association.id, contract_id: contractId, commande_id: command.commande_id,
          contract_version: contract.version, source_hash: source.source_hash } } });
    const at = new Date().toISOString();
    await enqueueEntityChanged(tx, { module: "clients", entityType: "CLIENT", entityId: clientId, action: "updated", at,
      invalidateKeys: ["clients", `client:${clientId}`, "client-contracts"] }, { deduplicationKey: `legacy-contract:${association.id}:client` });
    await enqueueEntityChanged(tx, { module: "commandes", entityType: "COMMANDE_CLIENT", entityId: command.commande_id, action: "updated", at,
      invalidateKeys: ["commandes:list", `commandes:detail:${command.commande_id}`] }, { deduplicationKey: `legacy-contract:${association.id}:order` });
    return { association, replayed: false };
  }, { reconcileCommit: async verifier => {
    const saved = await legacy.readLegacyAssociationReplay(verifier, audit.user_id, key);
    return !saved ? "not_committed" : saved.request_hash === hash ? "committed" : "unknown";
  } });
}
