import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueAppNotificationCreated } from "../../../shared/realtime/realtime-outbox.service";
import { repoCreateAppNotifications } from "../../notifications/repository/notifications.repository";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { repoCreateCommandeNativeTx, repoEnsureCommandeWorkflowStatus } from "../../commande-client/repository/commande-client.repository";
import { assertCompanyModuleAccess, type CompanyContext } from "../domain/company-context";
import { purchaseSubmittedPayloadSchema, type PurchaseSubmittedPayload } from "./intercompany-purchase.contract";
import { resolveSupplierPurchaseTx } from "./supplier-purchase.adapter";
import { enqueueIntercompanyMessageTx } from "./intercompany-outbox.repository";
import { intercompanyDigest, type IntercompanyMessage } from "./intercompany-message";
import { intercompanyRequestDecisionSchema, intercompanyRequestListSchema, type IntercompanyRequestDecision,
  type IntercompanyRequestDetail, type IntercompanyRequestList, type IntercompanyRequestState, type IntercompanyRequestSummary } from "./intercompany-request.contract";

const columns = `id::text,buyer_company_id::text,supplier_company_id::text,environment,
  buyer_legal_snapshot->>'legal_name' AS buyer_name,buyer_purchase_order_id,buyer_sales_order_id,
  revision,version::text,state,supplier_sales_order_id::text,
  jsonb_array_length(payload->'lines') AS line_count,created_at::text,updated_at::text,
  decided_at::text,decision_reason,payload`;
type RequestRow = Record<string, unknown>;
function summary(row: RequestRow): IntercompanyRequestSummary {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version)) throw new Error("INTERCOMPANY_VERSION_INVALID");
  return {
    id: String(row.id), buyer_company_id: String(row.buyer_company_id), supplier_company_id: String(row.supplier_company_id),
    environment: row.environment as "cerp_prod" | "cerp_test", buyer_name: row.buyer_name == null ? null : String(row.buyer_name),
    buyer_purchase_order_id: String(row.buyer_purchase_order_id), buyer_sales_order_id: String(row.buyer_sales_order_id),
    revision: Number(row.revision), version, state: row.state as IntercompanyRequestState,
    supplier_sales_order_id: row.supplier_sales_order_id == null ? null : Number(row.supplier_sales_order_id),
    line_count: Number(row.line_count), created_at: String(row.created_at), updated_at: String(row.updated_at),
    decided_at: row.decided_at == null ? null : String(row.decided_at), decision_reason: row.decision_reason == null ? null : String(row.decision_reason),
  };
}
function detail(row: RequestRow): IntercompanyRequestDetail {
  return { ...summary(row), payload: row.payload as Record<string, unknown>,
    allowed_actions: row.state === "PENDING_SUPPLIER_APPROVAL" ? ["ACCEPT", "REJECT"] :
      row.state === "CANCEL_REQUESTED" ? ["CONFIRM_CANCEL", "REJECT_CANCEL"] : [] };
}
function assertSellerContext(context: CompanyContext) {
  assertCompanyModuleAccess(context, "commandes-clients");
  if (context.profile !== "INDUSTRIAL") throw new HttpError(403, "INTERCOMPANY_SUPPLIER_WORKSPACE_REQUIRED", "Cette action appartient à l'entreprise qui réalise la commande.");
}
async function readScoped(tx: Pick<PoolClient, "query">, context: CompanyContext, id: string, lock = false): Promise<RequestRow> {
  const result = await tx.query<RequestRow>(`SELECT ${columns} FROM public.cerp_intercompany_requests
    WHERE id=$1::uuid AND supplier_company_id=$2::uuid AND environment=$3 ${lock ? "FOR UPDATE" : ""}`, [id, context.company_id, context.environment]);
  if (!result.rows[0]) throw new HttpError(404, "INTERCOMPANY_REQUEST_NOT_FOUND", "Demande client introuvable.");
  return result.rows[0];
}

export async function listIntercompanyRequests(db: Pool, context: CompanyContext, query: unknown): Promise<IntercompanyRequestList> {
  assertSellerContext(context);
  const input = intercompanyRequestListSchema.parse(query);
  const where = "supplier_company_id=$1::uuid AND environment=$2 AND ($3::text IS NULL OR state=$3)";
  const args = [context.company_id, context.environment, input.state ?? null];
  const [rows, count] = await Promise.all([
    db.query<RequestRow>(`SELECT ${columns} FROM public.cerp_intercompany_requests WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`, [...args, input.limit, (input.page - 1) * input.limit]),
    db.query<{ total: string }>(`SELECT count(*)::text AS total FROM public.cerp_intercompany_requests WHERE ${where}`, args),
  ]);
  return { items: rows.rows.map(summary), total: Number(count.rows[0]?.total ?? 0), page: input.page, limit: input.limit };
}
export async function getIntercompanyRequest(db: Pool, context: CompanyContext, id: string): Promise<IntercompanyRequestDetail> {
  assertSellerContext(context); return detail(await readScoped(db, context, id));
}

async function notifyApproval(tx: PoolClient, message: IntercompanyMessage, payload: PurchaseSubmittedPayload, requestId: string): Promise<void> {
  const recipients = await tx.query<{ id: number }>(`SELECT DISTINCT u.id FROM public.intercompany_supplier_relations r
    JOIN public.users u ON u.directory_profile_id=ANY(r.approval_profile_ids)
    JOIN public.app_module_user_access a ON a.user_id=u.id AND a.module_key='commandes-clients' AND a.access='GRANTED'
    WHERE r.id=$1::uuid AND r.buyer_company_id=$2::uuid AND r.supplier_company_id=$3::uuid AND r.environment=$4
      AND r.local_role='SUPPLIER' AND r.status='ACTIVE' AND lower(trim(u.status))='active'`,
    [payload.relation_id, message.source_company_id, message.destination_company_id, message.environment]);
  if (!recipients.rows.length) throw new HttpError(409, "INTERCOMPANY_APPROVAL_RECIPIENTS_UNAVAILABLE", "Les destinataires de validation doivent se connecter à leur entreprise et disposer du module Commandes clients.");
  const notifications = await repoCreateAppNotifications({ tx, user_ids: recipients.rows.map(row => row.id),
    kind: "intercompany.customer-order.requested", title: `Commande reçue de ${payload.buyer_legal_snapshot.legal_name}`,
    message: "Une commande client est à vérifier et à accepter avant son lancement.", severity: "info",
    action_url: `/commandes-clients?intercompany_request=${requestId}`, action_label: "Examiner la commande", action_key: "intercompany.review",
    entity_type: "intercompany_request", entity_id: requestId, module_key: "commandes-clients",
    payload: { request_id: requestId, buyer_company_id: message.source_company_id },
    dedupe_key: `intercompany:${requestId}:${message.kind}:revision:${message.revision}:approval`,
  });
  for (const notification of notifications) await enqueueAppNotificationCreated(tx, notification.user_id, notification, { deduplicationKey: `notification:${notification.id}` });
}

/** Authenticated peer delivery creates a request, never a native CRP order. */
export async function applyPurchaseSubmittedTx(tx: PoolClient, message: IntercompanyMessage): Promise<void> {
  const payload = purchaseSubmittedPayloadSchema.parse(message.payload);
  if (message.kind !== "PURCHASE_SUBMITTED" || message.aggregate_id !== payload.buyer_purchase_order_id)
    throw new HttpError(409, "INTERCOMPANY_PURCHASE_SCOPE_MISMATCH", "La demande ne correspond pas à son achat d'origine.");
  const relation = await tx.query<{ id: string }>(`SELECT id::text FROM public.intercompany_supplier_relations
    WHERE id=$1::uuid AND buyer_company_id=$2::uuid AND supplier_company_id=$3::uuid AND environment=$4
      AND local_role='SUPPLIER' AND status='ACTIVE' FOR SHARE`,
    [payload.relation_id, message.source_company_id, message.destination_company_id, message.environment]);
  if (!relation.rows[0]) throw new HttpError(403, "INTERCOMPANY_RELATION_REJECTED", "La relation entre entreprises n'est pas active.");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`intercompany-request:${message.environment}:${message.source_company_id}:${payload.buyer_purchase_order_id}`]);
  const existing = await tx.query<RequestRow>(`SELECT ${columns},payload_sha256 FROM public.cerp_intercompany_requests
    WHERE buyer_company_id=$1::uuid AND supplier_company_id=$2::uuid AND environment=$3 AND buyer_purchase_order_id=$4 FOR UPDATE`,
    [message.source_company_id, message.destination_company_id, message.environment, payload.buyer_purchase_order_id]);
  const prior = existing.rows[0];
  if (prior) {
    if (Number(prior.revision) > message.revision) return;
    if (Number(prior.revision) === message.revision) {
      if (prior.payload_sha256 !== message.payload_sha256) throw new HttpError(409, "INTERCOMPANY_PURCHASE_REVISION_CONFLICT", "La révision de la commande est incohérente.");
      return;
    }
    if (prior.state !== "PENDING_SUPPLIER_APPROVAL" || String(prior.buyer_sales_order_id) !== payload.buyer_sales_order_id)
      throw new HttpError(409, "INTERCOMPANY_ACCEPTED_ORDER_AMENDMENT_REQUIRED", "Une commande déjà décidée doit suivre une modification métier explicite.");
    await tx.query(`UPDATE public.cerp_intercompany_requests SET revision=$2,payload_sha256=$3,payload=$4::jsonb,
      buyer_legal_snapshot=$5::jsonb,final_delivery_address_snapshot=$6::jsonb,version=version+1,updated_at=now() WHERE id=$1::uuid`,
      [prior.id, message.revision, message.payload_sha256, JSON.stringify(payload), JSON.stringify(payload.buyer_legal_snapshot), JSON.stringify(payload.final_delivery_address_snapshot)]);
    await notifyApproval(tx, message, payload, String(prior.id)); return;
  }
  const id = randomUUID();
  await tx.query(`INSERT INTO public.cerp_intercompany_requests(id,buyer_company_id,supplier_company_id,environment,buyer_purchase_order_id,
    buyer_sales_order_id,relation_id,buyer_legal_snapshot,final_delivery_address_snapshot,revision,payload_sha256,payload)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb)`,
    [id, message.source_company_id, message.destination_company_id, message.environment, payload.buyer_purchase_order_id, payload.buyer_sales_order_id,
      payload.relation_id, JSON.stringify(payload.buyer_legal_snapshot), JSON.stringify(payload.final_delivery_address_snapshot), message.revision, message.payload_sha256, JSON.stringify(payload)]);
  await notifyApproval(tx, message, payload, id);
}

async function emitDecision(tx: PoolClient, row: RequestRow): Promise<void> {
  await enqueueIntercompanyMessageTx(tx, { destination_company_id: String(row.buyer_company_id), kind: "ORDER_DECIDED",
    aggregate_id: String(row.buyer_purchase_order_id), revision: Number(row.version), payload: {
      schema_version: 1, request_id: String(row.id), buyer_sales_order_id: String(row.buyer_sales_order_id), buyer_purchase_order_id: String(row.buyer_purchase_order_id),
      request_revision: Number(row.revision), decision_version: Number(row.version), state: String(row.state),
      supplier_sales_order_id: row.supplier_sales_order_id == null ? null : String(row.supplier_sales_order_id), reason: row.decision_reason ?? null,
    } });
}

export async function decideIntercompanyRequest(db: Pool, context: CompanyContext, actorUserId: number, id: string, input: unknown): Promise<IntercompanyRequestDetail> {
  assertSellerContext(context); const command = intercompanyRequestDecisionSchema.parse(input); const commandHash = intercompanyDigest(command);
  return withRealtimeOutboxTransaction(await db.connect(), async tx => {
    const row = await readScoped(tx, context, id, true);
    const replay = await tx.query<{ command_sha256: string; actor_user_id: number; response: IntercompanyRequestDetail }>(
      "SELECT command_sha256,actor_user_id,response FROM public.cerp_intercompany_decision_receipts WHERE request_id=$1::uuid AND idempotency_key=$2", [id, command.idempotency_key]);
    if (replay.rows[0]) {
      if (replay.rows[0].command_sha256 !== commandHash || replay.rows[0].actor_user_id !== actorUserId)
        throw new HttpError(409, "INTERCOMPANY_DECISION_KEY_REUSED", "Cette clé de décision désigne une autre demande.");
      return replay.rows[0].response;
    }
    if (Number(row.version) !== command.expected_version) throw new HttpError(409, "INTERCOMPANY_REQUEST_VERSION_CONFLICT", "La demande a changé. Rechargez-la avant de décider.");
    if (!detail(row).allowed_actions.includes(command.action)) throw new HttpError(409, "INTERCOMPANY_DECISION_NOT_ALLOWED", "Cette décision n'est pas disponible dans l'état courant.");
    let next: IntercompanyRequestState; let supplierOrderId = row.supplier_sales_order_id;
    if (command.action === "ACCEPT") {
      const payload = purchaseSubmittedPayloadSchema.parse(row.payload);
      const nativeInput = await resolveSupplierPurchaseTx(tx, payload, { source_company_id: String(row.buyer_company_id), destination_company_id: context.company_id, environment: context.environment });
      const created = await repoCreateCommandeNativeTx(tx, nativeInput, actorUserId); supplierOrderId = String(created.id);
      const lines = await tx.query<{ id: string; article_id: string; quantite: number; unite: string }>(
        "SELECT id::text,article_id::text,quantite::float8 AS quantite,unite FROM public.commande_ligne WHERE commande_id=$1 ORDER BY id", [created.id]);
      if (lines.rows.length !== payload.lines.length) throw new Error("INTERCOMPANY_NATIVE_LINE_COUNT_MISMATCH");
      for (const [index, source] of payload.lines.entries()) {
        const target = lines.rows[index];
        if (target.article_id !== source.supplier_article_id || Number(target.quantite) !== source.quantity || target.unite !== source.unit)
          throw new Error("INTERCOMPANY_NATIVE_LINE_BINDING_MISMATCH");
        await tx.query(`INSERT INTO public.cerp_intercompany_order_line_links(request_id,buyer_sales_order_line_id,buyer_purchase_order_line_id,supplier_sales_order_line_id,supplier_article_id,quantity,unit)
          VALUES($1::uuid,$2,$3,$4::bigint,$5::uuid,$6,$7)`, [id, source.buyer_sales_order_line_id, source.buyer_purchase_order_line_id, target.id, source.supplier_article_id, source.quantity, source.unit]);
      }
      next = "ACCEPTED";
    } else if (command.action === "REJECT") next = "REJECTED";
    else if (command.action === "REJECT_CANCEL") next = "CANCELLATION_REJECTED";
    else {
      if (!supplierOrderId) throw new Error("INTERCOMPANY_NATIVE_ORDER_MISSING");
      const linked = await tx.query<{ blocked: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM public.ordres_fabrication WHERE commande_id=$1 AND statut::text <> 'ANNULE')
        OR EXISTS(SELECT 1 FROM public.commande_ligne line JOIN public.stock_reservations reservation ON reservation.commande_ligne_id=line.id WHERE line.commande_id=$1)
        OR EXISTS(SELECT 1 FROM public.bon_livraison WHERE commande_id=$1 AND statut <> 'CANCELLED') AS blocked`, [supplierOrderId]);
      if (linked.rows[0]?.blocked) throw new HttpError(409, "INTERCOMPANY_CANCELLATION_NATIVE_RELEASE_REQUIRED", "Traitez d'abord les OF, réservations et livraisons dans leurs modules avant de confirmer l'annulation.");
      await repoEnsureCommandeWorkflowStatus({ tx, commande_id: Number(supplierOrderId), nouveau_statut: "ANNULE", cause: "cancel", commentaire: command.reason ?? "Annulation demandée par l'entreprise acheteuse", user_id: actorUserId });
      next = "CANCELLED";
    }
    await tx.query(`UPDATE public.cerp_intercompany_requests SET state=$2,supplier_sales_order_id=$3::bigint,decision_reason=$4,
      decided_by=$5,decided_at=now(),version=version+1,updated_at=now() WHERE id=$1::uuid`, [id, next, supplierOrderId ?? null, command.reason ?? null, actorUserId]);
    const updated = await readScoped(tx, context, id); const response = detail(updated);
    await emitDecision(tx, updated);
    await repoInsertAuditLog({ tx, user_id: actorUserId, body: { event_type: "ACTION", action: "INTERCOMPANY_REQUEST_DECIDED", page_key: "commandes-clients",
      entity_type: "intercompany_request", entity_id: id, path: `/api/v1/commandes/intercompany/requests/${id}/decision`,
      details: { action: command.action, version: response.version, supplier_sales_order_id: response.supplier_sales_order_id } },
      ip: null, user_agent: null, device_type: null, os: null, browser: null });
    await tx.query(`INSERT INTO public.cerp_intercompany_decision_receipts(request_id,idempotency_key,command_sha256,response,actor_user_id)
      VALUES($1::uuid,$2,$3,$4::jsonb,$5)`, [id, command.idempotency_key, commandHash, JSON.stringify(response), actorUserId]);
    return response;
  }, { reconcileCommit: async verifier => {
    const found = await verifier.query<{ command_sha256: string }>("SELECT command_sha256 FROM public.cerp_intercompany_decision_receipts WHERE request_id=$1::uuid AND idempotency_key=$2", [id, command.idempotency_key]);
    return found.rows[0]?.command_sha256 === commandHash ? "committed" : "unknown";
  } });
}

export async function applyCancellationRequestedTx(tx: PoolClient, message: IntercompanyMessage): Promise<void> {
  const row = (await tx.query<RequestRow>(`SELECT ${columns} FROM public.cerp_intercompany_requests WHERE buyer_company_id=$1::uuid
    AND supplier_company_id=$2::uuid AND environment=$3 AND buyer_purchase_order_id=$4 FOR UPDATE`,
    [message.source_company_id, message.destination_company_id, message.environment, message.aggregate_id])).rows[0];
  if (!row) throw new HttpError(404, "INTERCOMPANY_REQUEST_NOT_FOUND", "Demande client introuvable.");
  if (["CANCELLED", "CANCEL_REQUESTED"].includes(String(row.state))) return;
  const next = row.state === "PENDING_SUPPLIER_APPROVAL" || row.state === "REJECTED" ? "CANCELLED" :
    ["ACCEPTED", "CANCELLATION_REJECTED"].includes(String(row.state)) ? "CANCEL_REQUESTED" : null;
  if (!next) throw new HttpError(409, "INTERCOMPANY_CANCELLATION_FULFILMENT_STARTED", "Une livraison réalisée doit suivre le circuit de retour et d'avoir.");
  await tx.query("UPDATE public.cerp_intercompany_requests SET state=$2,version=version+1,updated_at=now() WHERE id=$1::uuid", [row.id, next]);
  if (next === "CANCELLED") await emitDecision(tx, { ...row, state: next, version: Number(row.version) + 1 });
  else await notifyApproval(tx, message, purchaseSubmittedPayloadSchema.parse(row.payload), String(row.id));
}
