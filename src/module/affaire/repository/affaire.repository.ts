import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type {
  ListAffairesCommandCenterQueryDTO,
  ListAffairesQueryDTO,
  CreateAffaireBodyDTO,
  UpdateAffaireBodyDTO,
} from "../validators/affaire.validators";
import type {
  Affaire,
  AffaireCommandCenterItem,
  AffaireListItem,
  AffaireOperationsDetail,
  AffaireTraceabilitySource,
  AffaireTimelineEvent,
  AuditContext,
  ClientLite,
  CommandeHeaderLite,
  DevisHeaderLite,
} from "../types/affaire.types";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null };
  const code = typeof err.code === "string" ? err.code : null;
  const constraint = typeof err.constraint === "string" ? err.constraint : null;
  return { code, constraint };
}

function toNumber(value: unknown, label = "value"): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableNumber(value: unknown, label = "value"): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value, label);
}

function asObjectArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asTraceabilitySources(value: unknown): AffaireTraceabilitySource[] {
  return asObjectArray<AffaireTraceabilitySource>(value);
}

async function insertAffaireAuditLog(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  entry: {
    action: string;
    entity_id: string;
    details?: Record<string, unknown> | null;
  }
) {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action: entry.action,
      page_key: audit.page_key ?? "affaires",
      entity_type: "affaire",
      entity_id: entry.entity_id,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details: entry.details ?? null,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

function sortColumn(sortBy: ListAffairesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "reference":
      return "a.reference";
    case "date_ouverture":
      return "a.date_ouverture";
    case "updated_at":
    default:
      return "a.updated_at";
  }
}

function sortDirection(sortDir: ListAffairesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListAffairesQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(a.reference ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`a.reference ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`a.client_id = ${p}`);
  }

  if (filters.statut) {
    const p = push(filters.statut);
    where.push(`a.statut = ${p}`);
  }

  if (filters.type_affaire) {
    const p = push(filters.type_affaire);
    where.push(`a.type_affaire = ${p}`);
  }

  if (filters.open_from) {
    const p = push(filters.open_from);
    where.push(`a.date_ouverture >= ${p}::date`);
  }

  if (filters.open_to) {
    const p = push(filters.open_to);
    where.push(`a.date_ouverture <= ${p}::date`);
  }

  if (filters.close_from) {
    const p = push(filters.close_from);
    where.push(`a.date_cloture >= ${p}::date`);
  }

  if (filters.close_to) {
    const p = push(filters.close_to);
    where.push(`a.date_cloture <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

type CommandCenterWhere = { whereSql: string; values: unknown[] };
function buildCommandCenterWhere(filters: ListAffairesCommandCenterQueryDTO): CommandCenterWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    where.push(`(
      a.reference ILIKE ${p}
      OR COALESCE(c.company_name,'') ILIKE ${p}
      OR COALESCE(cc.numero,'') ILIKE ${p}
      OR EXISTS (SELECT 1 FROM bon_livraison blq WHERE blq.affaire_id = a.id AND blq.numero ILIKE ${p})
      OR EXISTS (SELECT 1 FROM facture fq WHERE fq.affaire_id = a.id AND fq.numero ILIKE ${p})
      OR EXISTS (SELECT 1 FROM ordres_fabrication ofq WHERE ofq.affaire_id = a.id AND ofq.numero ILIKE ${p})
    )`);
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    where.push(`a.client_id = ${push(filters.client_id.trim())}`);
  }
  if (filters.statut) where.push(`a.statut = ${push(filters.statut)}`);
  if (filters.type_affaire) where.push(`a.type_affaire = ${push(filters.type_affaire)}`);
  if (filters.open_from) where.push(`a.date_ouverture >= ${push(filters.open_from)}::date`);
  if (filters.open_to) where.push(`a.date_ouverture <= ${push(filters.open_to)}::date`);
  if (filters.close_from) where.push(`a.date_cloture >= ${push(filters.close_from)}::date`);
  if (filters.close_to) where.push(`a.date_cloture <= ${push(filters.close_to)}::date`);

  switch (filters.segment) {
    case "active":
      where.push(`a.statut NOT IN ('CLOTUREE','ANNULEE')`);
      break;
    case "production":
      where.push(`COALESCE(prod.of_count, 0) > 0 AND COALESCE(prod.done_count, 0) < COALESCE(prod.of_count, 0)`);
      break;
    case "control":
      where.push(`wf.current_checkpoint = 'quality_control'`);
      break;
    case "ready_delivery":
      where.push(`COALESCE(bl.ready_count, 0) > 0 OR wf.current_checkpoint = 'delivery'`);
      break;
    case "partial_delivered":
      where.push(`COALESCE(bl.delivered_count, 0) > 0 AND COALESCE(bl.delivered_count, 0) < COALESCE(bl.bl_count, 0)`);
      break;
    case "delivered":
      where.push(`COALESCE(bl.bl_count, 0) > 0 AND COALESCE(bl.delivered_count, 0) = COALESCE(bl.bl_count, 0)`);
      break;
    case "to_invoice":
      where.push(`COALESCE(bl.delivered_count, 0) > 0 AND COALESCE(fac.facture_count, 0) = 0`);
      break;
    case "blocked":
      where.push(`wf.current_status = 'blocked' OR a.statut = 'SUSPENDUE'`);
      break;
    case "late":
      where.push(`(
        (wf.due_at IS NOT NULL AND wf.due_at < now() AND wf.current_status NOT IN ('done','skipped'))
        OR (prod.planned_end_at IS NOT NULL AND prod.planned_end_at < CURRENT_DATE AND COALESCE(prod.done_count, 0) < COALESCE(prod.of_count, 0))
        OR (bl.planned_at IS NOT NULL AND bl.planned_at < CURRENT_DATE AND COALESCE(bl.delivered_count, 0) < COALESCE(bl.bl_count, 0))
      )`);
      break;
    default:
      break;
  }

  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", values };
}

type CommandCenterRow = {
  id: string;
  reference: string;
  client_id: string | null;
  commande_id: string | null;
  devis_id: string | null;
  type_affaire: string;
  statut: string;
  date_ouverture: string;
  date_cloture: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
  client: ClientLite | null;
  commande: {
    id: string;
    numero: string;
    statut: string | null;
    date_commande: string | null;
    total_ht: number | null;
    total_ttc: number | null;
  } | null;
  current_checkpoint: string | null;
  current_label: string | null;
  current_status: string | null;
  responsible_role: string | null;
  blocked_reason: string | null;
  due_at: string | null;
  of_count: number;
  of_done_count: number;
  of_running_count: number;
  of_blocked_count: number;
  of_planned_end_at: string | null;
  of_last_update_at: string | null;
  bl_count: number;
  bl_delivered_count: number;
  bl_shipped_count: number;
  bl_ready_count: number;
  bl_last_numero: string | null;
  bl_planned_at: string | null;
  bl_delivered_at: string | null;
  bl_tracking_number: string | null;
  bl_last_update_at: string | null;
  facture_count: number;
  facture_total_ht: number;
  facture_total_ttc: number;
  facture_paid_ttc: number;
  facture_remaining_ttc: number;
  facture_last_numero: string | null;
  facture_last_update_at: string | null;
  audit_count: number;
  audit_last_audit_at: string | null;
  traceability: unknown;
};

function deriveProductionStatus(row: CommandCenterRow): string {
  if (row.of_count <= 0) return "NOT_REQUIRED";
  if (row.of_blocked_count > 0) return "BLOCKED";
  if (row.of_done_count >= row.of_count) return "DONE";
  if (row.of_running_count > 0) return "RUNNING";
  return "PLANNED";
}

function deriveLivraisonStatus(row: CommandCenterRow): string {
  if (row.bl_count <= 0) return "PENDING";
  if (row.bl_delivered_count >= row.bl_count) return "DELIVERED";
  if (row.bl_shipped_count > 0) return "SHIPPED";
  if (row.bl_ready_count > 0) return "READY";
  return "DRAFT";
}

function deriveFacturationStatus(row: CommandCenterRow): string {
  if (row.facture_count <= 0) return "TO_INVOICE";
  if (row.facture_remaining_ttc <= 0) return "PAID";
  if (row.facture_paid_ttc > 0) return "PARTIAL_PAID";
  return "ISSUED";
}

function deriveProductionUiStatus(row: CommandCenterRow): AffaireCommandCenterItem["status"]["production"] {
  if (row.of_count <= 0) return "none";
  if (row.of_blocked_count > 0) return "blocked";
  if (row.of_done_count >= row.of_count) return "completed";
  if (row.of_running_count > 0) return "in_progress";
  return "waiting";
}

function deriveLivraisonUiStatus(row: CommandCenterRow): AffaireCommandCenterItem["status"]["livraison"] {
  if (row.bl_count <= 0) return row.of_count > 0 && row.of_done_count >= row.of_count ? "ready" : "none";
  if (row.bl_delivered_count >= row.bl_count) return "delivered";
  if (row.bl_delivered_count > 0 || row.bl_shipped_count > 0) return "partial";
  if (row.bl_ready_count > 0) return "ready";
  return "none";
}

function deriveFacturationUiStatus(row: CommandCenterRow): AffaireCommandCenterItem["status"]["facturation"] {
  if (row.facture_count <= 0) return row.bl_delivered_count > 0 ? "to_invoice" : "none";
  if (row.facture_remaining_ttc <= 0) return "paid";
  if (row.facture_paid_ttc > 0) return "partial";
  return "to_invoice";
}

function deriveLegacyNextAction(row: CommandCenterRow) {
  if (row.current_status === "blocked" || row.statut === "SUSPENDUE") {
    return row.blocked_reason ? `Lever le blocage: ${row.blocked_reason}` : "Lever le blocage";
  }
  if (row.current_checkpoint && row.current_status === "active") {
    return { key: `checkpoint:${row.current_checkpoint}`, label: row.current_label ?? "Traiter l'étape active", role: row.responsible_role };
  }
  if (row.of_count > 0 && row.of_done_count < row.of_count) {
    return "Suivre la production";
  }
  if (row.bl_count === 0) {
    return { key: "prepare_delivery", label: "Préparer la livraison", role: "logistique" };
  }
  if (row.bl_delivered_count < row.bl_count) {
    return { key: "ship_or_confirm_delivery", label: "Expédier ou confirmer la réception", role: "logistique" };
  }
  if (row.facture_count === 0 || row.facture_remaining_ttc > 0) {
    return { key: "invoice_or_follow_payment", label: "Facturer ou suivre le règlement", role: "comptabilite" };
  }
  return { key: "close_affaire", label: "Clôturer le dossier", role: "direction" };
}

function deriveNextAction(row: CommandCenterRow): string {
  if (row.current_status === "blocked" || row.statut === "SUSPENDUE") {
    return row.blocked_reason ? `Lever le blocage: ${row.blocked_reason}` : "Lever le blocage";
  }
  if (row.current_checkpoint && row.current_status === "active") {
    return row.current_label ?? "Traiter l'etape active";
  }
  if (row.of_count > 0 && row.of_done_count < row.of_count) {
    return "Suivre la production";
  }
  if (row.bl_count === 0) {
    return "Preparer la livraison";
  }
  if (row.bl_delivered_count < row.bl_count) {
    return "Expedier ou confirmer la reception";
  }
  if (row.facture_count === 0 || row.facture_remaining_ttc > 0) {
    return "Facturer ou suivre le reglement";
  }
  return "Cloturer le dossier";
}

function deriveRiskFlags(row: CommandCenterRow): string[] {
  const flags: string[] = [];
  if (row.current_status === "blocked" || row.statut === "SUSPENDUE") flags.push("blocked");
  if (row.due_at && Date.parse(row.due_at) < Date.now() && row.current_status !== "done") flags.push("workflow_late");
  if (row.of_planned_end_at && Date.parse(row.of_planned_end_at) < Date.now() && row.of_done_count < row.of_count) {
    flags.push("production_late");
  }
  if (row.bl_planned_at && Date.parse(row.bl_planned_at) < Date.now() && row.bl_delivered_count < row.bl_count) {
    flags.push("delivery_late");
  }
  if (row.facture_count === 0 && row.bl_delivered_count > 0) flags.push("invoice_missing");
  return Array.from(new Set(flags));
}

function mapCommandCenterRow(row: CommandCenterRow): AffaireCommandCenterItem {
  const productionStatus = deriveProductionStatus(row);
  const livraisonStatus = deriveLivraisonStatus(row);
  const completionRate = row.of_count > 0 ? Math.round((row.of_done_count / row.of_count) * 100) : 0;
  const partialDeliveryCount = row.bl_delivered_count > 0 && row.bl_delivered_count < row.bl_count ? 1 : 0;
  const paidInvoiceCount = row.facture_count > 0 && row.facture_remaining_ttc <= 0 ? row.facture_count : 0;
  const unpaidInvoiceCount = row.facture_count > paidInvoiceCount ? row.facture_count - paidInvoiceCount : 0;

  return {
    id: toInt(row.id, "affaire.id"),
    reference: row.reference,
    statut: row.statut,
    client: row.client,
    commande: row.commande
      ? {
          id: toInt(row.commande.id, "commande.id"),
          numero: row.commande.numero,
          statut: row.commande.statut,
          workflow_status: row.current_status,
          total_ht: toNullableNumber(row.commande.total_ht, "commande.total_ht"),
          date_commande: row.commande.date_commande,
        }
      : { id: null, numero: null, statut: null, workflow_status: null, total_ht: null, date_commande: null },
    production: {
      of_count: Number(row.of_count),
      open_count: Math.max(0, Number(row.of_count) - Number(row.of_done_count)),
      blocked_count: Number(row.of_blocked_count),
      completed_count: Number(row.of_done_count),
      latest_status: productionStatus,
      completion_rate: completionRate,
    },
    livraison: {
      bl_count: Number(row.bl_count),
      partial_count: partialDeliveryCount,
      delivered_count: Number(row.bl_delivered_count),
      latest_status: livraisonStatus,
      latest_date: row.bl_delivered_at ?? row.bl_planned_at ?? row.bl_last_update_at,
      tracking_number: row.bl_tracking_number,
    },
    facturation: {
      facture_count: Number(row.facture_count),
      paid_count: paidInvoiceCount,
      unpaid_count: unpaidInvoiceCount,
      avoir_count: 0,
      total_ht: Number(row.facture_total_ht),
      total_ttc: Number(row.facture_total_ttc),
      paid_amount: Number(row.facture_paid_ttc),
      open_amount: Number(row.facture_remaining_ttc),
    },
    control: {
      active_checkpoint_count: row.current_checkpoint && row.current_status === "active" ? 1 : 0,
      blocked_checkpoint_count: row.current_status === "blocked" ? 1 : 0,
      active_checkpoint_labels: row.current_label ? [row.current_label] : [],
      last_workflow_event_at: row.due_at,
      audit_event_count: Number(row.audit_count),
      last_audit_at: row.audit_last_audit_at,
    },
    status: {
      production: deriveProductionUiStatus(row),
      livraison: deriveLivraisonUiStatus(row),
      facturation: deriveFacturationUiStatus(row),
    },
    next_action: deriveNextAction(row),
    risk_flags: deriveRiskFlags(row),
    traceability: asTraceabilitySources(row.traceability),
    date_ouverture: row.date_ouverture,
    updated_at: row.updated_at,
  };
}

export async function repoListAffaires(filters: ListAffairesQueryDTO) {
  const includes = includesSet(filters.include ?? "");
  const includeClient = includes.has("client");

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const { whereSql, values } = buildListWhere(filters, includeClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM affaire a
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.type_affaire,
      a.statut,
      a.date_ouverture::text AS date_ouverture,
      a.date_cloture::text AS date_cloture,
      a.commentaire,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM affaire a
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  type AffaireListRow = Omit<AffaireListItem, "id" | "commande_id" | "devis_id"> & {
    id: string;
    commande_id: string | null;
    devis_id: string | null;
    client: ClientLite | null;
  };

  const dataRes = await pool.query<AffaireListRow>(dataSql, [...values, pageSize, offset]);
  const items: AffaireListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "affaire.id"),
    commande_id: toNullableInt(r.commande_id, "affaire.commande_id"),
    devis_id: toNullableInt(r.devis_id, "affaire.devis_id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

function commandCenterFromSql(whereSql: string, orderBy: string, orderDir: string) {
  return `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.type_affaire,
      a.statut,
      a.date_ouverture::text AS date_ouverture,
      a.date_cloture::text AS date_cloture,
      a.commentaire,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client,
      CASE WHEN cc.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', cc.id::text,
        'numero', cc.numero,
        'statut', cmd_status.nouveau_statut,
        'date_commande', cc.date_commande::text,
        'total_ht', cc.total_ht::float8,
        'total_ttc', cc.total_ttc::float8
      ) END AS commande,
      wf.current_checkpoint,
      wf.current_label,
      wf.current_status,
      wf.responsible_role,
      wf.blocked_reason,
      wf.due_at::text AS due_at,
      COALESCE(prod.of_count, 0)::int AS of_count,
      COALESCE(prod.done_count, 0)::int AS of_done_count,
      COALESCE(prod.running_count, 0)::int AS of_running_count,
      COALESCE(prod.blocked_count, 0)::int AS of_blocked_count,
      prod.planned_end_at::text AS of_planned_end_at,
      prod.last_update_at::text AS of_last_update_at,
      COALESCE(bl.bl_count, 0)::int AS bl_count,
      COALESCE(bl.delivered_count, 0)::int AS bl_delivered_count,
      COALESCE(bl.shipped_count, 0)::int AS bl_shipped_count,
      COALESCE(bl.ready_count, 0)::int AS bl_ready_count,
      bl.last_numero AS bl_last_numero,
      bl.planned_at::text AS bl_planned_at,
      bl.delivered_at::text AS bl_delivered_at,
      bl.tracking_number AS bl_tracking_number,
      bl.last_update_at::text AS bl_last_update_at,
      COALESCE(fac.facture_count, 0)::int AS facture_count,
      COALESCE(fac.total_ht, 0)::float8 AS facture_total_ht,
      COALESCE(fac.total_ttc, 0)::float8 AS facture_total_ttc,
      COALESCE(fac.paid_ttc, 0)::float8 AS facture_paid_ttc,
      COALESCE(fac.remaining_ttc, 0)::float8 AS facture_remaining_ttc,
      fac.last_numero AS facture_last_numero,
      fac.last_update_at::text AS facture_last_update_at,
      COALESCE(audit.audit_count, 0)::int AS audit_count,
      audit.last_audit_at::text AS audit_last_audit_at,
      jsonb_build_array(
        jsonb_build_object('section','affaire','source_table','affaire','source_id',a.id::text,'source_ref',a.reference,'status',a.statut,'updated_at',a.updated_at::text,'evidence_count',1),
        jsonb_build_object('section','commande','source_table','commande_client','source_id',cc.id::text,'source_ref',cc.numero,'status',cmd_status.nouveau_statut,'updated_at',cc.updated_at::text,'evidence_count',CASE WHEN cc.id IS NULL THEN 0 ELSE 1 END),
        jsonb_build_object('section','production','source_table','ordres_fabrication','source_id',NULL,'source_ref',NULL,'status',prod.rollup_status,'updated_at',prod.last_update_at::text,'evidence_count',COALESCE(prod.of_count,0)),
        jsonb_build_object('section','livraison','source_table','bon_livraison','source_id',NULL,'source_ref',bl.last_numero,'status',bl.rollup_status,'updated_at',bl.last_update_at::text,'evidence_count',COALESCE(bl.bl_count,0)),
        jsonb_build_object('section','facturation','source_table','facture','source_id',NULL,'source_ref',fac.last_numero,'status',fac.rollup_status,'updated_at',fac.last_update_at::text,'evidence_count',COALESCE(fac.facture_count,0)),
        jsonb_build_object('section','audit','source_table','erp_audit_logs','source_id',NULL,'source_ref',NULL,'status',NULL,'updated_at',audit.last_audit_at::text,'evidence_count',COALESCE(audit.audit_count,0))
      ) AS traceability
    FROM affaire a
    LEFT JOIN clients c ON c.client_id = a.client_id
    LEFT JOIN commande_client cc ON cc.id = a.commande_id
    LEFT JOIN LATERAL (
      SELECT ch.nouveau_statut
      FROM commande_historique ch
      WHERE ch.commande_id = cc.id
      ORDER BY ch.date_action DESC, ch.id DESC
      LIMIT 1
    ) cmd_status ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        cp.checkpoint_code AS current_checkpoint,
        cp.label AS current_label,
        cp.status AS current_status,
        cp.responsible_role,
        cp.blocked_reason,
        cp.due_at
      FROM commande_client_workflow_checkpoint cp
      WHERE cp.commande_id = cc.id
        AND cp.status IN ('active','blocked')
      ORDER BY CASE cp.status WHEN 'blocked' THEN 0 ELSE 1 END, cp.sort_order ASC
      LIMIT 1
    ) wf ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS of_count,
        COUNT(*) FILTER (WHERE o.statut IN ('TERMINE','CLOTURE'))::int AS done_count,
        COUNT(*) FILTER (WHERE o.statut = 'EN_COURS')::int AS running_count,
        COUNT(*) FILTER (WHERE o.statut = 'EN_PAUSE')::int AS blocked_count,
        MIN(o.date_fin_prevue) FILTER (WHERE o.statut NOT IN ('TERMINE','CLOTURE','ANNULE')) AS planned_end_at,
        MAX(o.updated_at) AS last_update_at,
        CASE
          WHEN COUNT(*) = 0 THEN 'NOT_REQUIRED'
          WHEN COUNT(*) FILTER (WHERE o.statut = 'EN_PAUSE') > 0 THEN 'BLOCKED'
          WHEN COUNT(*) FILTER (WHERE o.statut IN ('TERMINE','CLOTURE')) = COUNT(*) THEN 'DONE'
          WHEN COUNT(*) FILTER (WHERE o.statut = 'EN_COURS') > 0 THEN 'RUNNING'
          ELSE 'PLANNED'
        END AS rollup_status
      FROM ordres_fabrication o
      WHERE o.affaire_id = a.id
    ) prod ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS bl_count,
        COUNT(*) FILTER (WHERE bl.statut = 'DELIVERED')::int AS delivered_count,
        COUNT(*) FILTER (WHERE bl.statut = 'SHIPPED')::int AS shipped_count,
        COUNT(*) FILTER (WHERE bl.statut = 'READY')::int AS ready_count,
        (array_agg(bl.numero ORDER BY bl.updated_at DESC, bl.numero DESC))[1] AS last_numero,
        MIN(COALESCE(bl.date_expedition, bl.date_livraison)) FILTER (WHERE bl.statut NOT IN ('DELIVERED','CANCELLED')) AS planned_at,
        MAX(bl.date_livraison) AS delivered_at,
        (array_agg(bl.tracking_number ORDER BY bl.updated_at DESC) FILTER (WHERE bl.tracking_number IS NOT NULL))[1] AS tracking_number,
        MAX(bl.updated_at) AS last_update_at,
        CASE
          WHEN COUNT(*) = 0 THEN 'PENDING'
          WHEN COUNT(*) FILTER (WHERE bl.statut = 'DELIVERED') = COUNT(*) THEN 'DELIVERED'
          WHEN COUNT(*) FILTER (WHERE bl.statut = 'SHIPPED') > 0 THEN 'SHIPPED'
          WHEN COUNT(*) FILTER (WHERE bl.statut = 'READY') > 0 THEN 'READY'
          ELSE 'DRAFT'
        END AS rollup_status
      FROM bon_livraison bl
      WHERE bl.affaire_id = a.id
    ) bl ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS facture_count,
        COALESCE(SUM(f.total_ht), 0)::float8 AS total_ht,
        COALESCE(SUM(f.total_ttc), 0)::float8 AS total_ttc,
        COALESCE(SUM(pay.total_paye_ttc), 0)::float8 AS paid_ttc,
        COALESCE(SUM(GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc)), 0)::float8 AS remaining_ttc,
        (array_agg(f.numero ORDER BY f.updated_at DESC, f.id DESC))[1] AS last_numero,
        MAX(f.updated_at) AS last_update_at,
        CASE
          WHEN COUNT(*) = 0 THEN 'TO_INVOICE'
          WHEN COALESCE(SUM(GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc)), 0) <= 0 THEN 'PAID'
          WHEN COALESCE(SUM(pay.total_paye_ttc), 0) > 0 THEN 'PARTIAL_PAID'
          ELSE 'ISSUED'
        END AS rollup_status
      FROM facture f
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.montant), 0)::float8 AS total_paye_ttc
        FROM paiement p
        WHERE p.facture_id = f.id
      ) pay ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(av.total_ttc), 0)::float8 AS total_avoirs_ttc
        FROM avoir av
        WHERE av.facture_id = f.id
          AND COALESCE(av.statut, '') <> 'brouillon'
      ) av ON TRUE
      WHERE f.affaire_id = a.id
    ) fac ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS audit_count, MAX(eal.created_at) AS last_audit_at
      FROM erp_audit_logs eal
      WHERE eal.entity_type = 'affaire'
        AND eal.entity_id = a.id::text
    ) audit ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}, a.id ${orderDir}
  `;
}

export async function repoListAffairesCommandCenter(filters: ListAffairesCommandCenterQueryDTO) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  const { whereSql, values } = buildCommandCenterWhere(filters);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await pool.query<{ total: number }>(
    `
    SELECT COUNT(*)::int AS total
    FROM (
      ${commandCenterFromSql(whereSql, "a.id", "ASC")}
    ) scoped
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    ${commandCenterFromSql(whereSql, orderBy, orderDir)}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const dataRes = await pool.query<CommandCenterRow>(dataSql, [...values, pageSize, offset]);
  return {
    items: dataRes.rows.map(mapCommandCenterRow),
    total,
  };
}

export async function repoGetAffaire(id: number, includeValue: string) {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");
  const includeCommande = includes.has("commande");
  const includeDevis = includes.has("devis");

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = a.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const sql = `
    SELECT
      a.id::text AS id,
      a.reference,
      a.client_id,
      a.commande_id::text AS commande_id,
      a.devis_id::text AS devis_id,
      a.type_affaire,
      a.statut,
      a.date_ouverture::text AS date_ouverture,
      a.date_cloture::text AS date_cloture,
      a.commentaire,
      a.created_at::text AS created_at,
      a.updated_at::text AS updated_at,
      ${clientSelectSql}
    FROM affaire a
    ${joinClientSql}
    WHERE a.id = $1
  `;

  type BaseRow = Omit<Affaire, "id" | "commande_id" | "devis_id" | "client" | "commande" | "devis"> & {
    id: string;
    commande_id: string | null;
    devis_id: string | null;
    client: ClientLite | null;
  };

  const baseRes = await pool.query<BaseRow>(sql, [id]);
  const r = baseRes.rows[0] ?? null;
  if (!r) return null;

  const affaire: Affaire = {
    ...r,
    id: toInt(r.id, "affaire.id"),
    commande_id: toNullableInt(r.commande_id, "affaire.commande_id"),
    devis_id: toNullableInt(r.devis_id, "affaire.devis_id"),
    client: includeClient ? r.client : undefined,
  };

  if (includeCommande && affaire.commande_id) {
    const commandeSql = `
      SELECT
        cc.id::text AS id,
        cc.numero,
        cc.client_id,
        cc.date_commande::text AS date_commande,
        cc.total_ht::float8 AS total_ht,
        cc.total_ttc::float8 AS total_ttc,
        cc.updated_at::text AS updated_at,
        COALESCE(st.nouveau_statut, 'brouillon') AS statut
      FROM commande_client cc
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      WHERE cc.id = $1
    `;

    type CmdRow = Omit<CommandeHeaderLite, "id"> & { id: string };
    const cmdRes = await pool.query<CmdRow>(commandeSql, [affaire.commande_id]);
    const cmd = cmdRes.rows[0] ?? null;
    affaire.commande = cmd
      ? {
          ...cmd,
          id: toInt(cmd.id, "commande.id"),
        }
      : null;
  }

  if (includeDevis && affaire.devis_id) {
    const devisSql = `
      SELECT
        d.id::text AS id,
        d.numero,
        d.client_id,
        d.date_creation::text AS date_creation,
        d.date_validite::text AS date_validite,
        d.statut,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc
      FROM devis d
      WHERE d.id = $1
    `;
    type DevisRow = Omit<DevisHeaderLite, "id"> & { id: string };
    const devisRes = await pool.query<DevisRow>(devisSql, [affaire.devis_id]);
    const devis = devisRes.rows[0] ?? null;
    affaire.devis = devis
      ? {
          ...devis,
          id: toInt(devis.id, "devis.id"),
        }
      : null;
  }

  return affaire;
}

export async function repoGetAffaireOperations(id: number): Promise<AffaireOperationsDetail | null> {
  const baseRes = await pool.query<CommandCenterRow>(commandCenterFromSql("WHERE a.id = $1", "a.updated_at", "DESC"), [id]);
  const baseRow = baseRes.rows[0] ?? null;
  if (!baseRow) return null;
  const affaire = mapCommandCenterRow(baseRow);

  const allocationsRes = await pool.query<{
    id: string;
    commande_ligne_id: string;
    article_ref_id: string | null;
    article_legacy_id: string | null;
    qty_ordered: number;
    qty_from_stock: number;
    qty_reserved: number;
    qty_to_produce: number;
    allocation_mode: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
    SELECT
      id::text AS id,
      commande_ligne_id::text AS commande_ligne_id,
      article_ref_id::text AS article_ref_id,
      article_legacy_id::text AS article_legacy_id,
      qty_ordered::float8 AS qty_ordered,
      qty_from_stock::float8 AS qty_from_stock,
      qty_reserved::float8 AS qty_reserved,
      qty_to_produce::float8 AS qty_to_produce,
      allocation_mode,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM commande_ligne_affaire_allocation
    WHERE livraison_affaire_id = $1
    ORDER BY commande_ligne_id ASC, id ASC
    `,
    [id]
  );

  const ofsRes = await pool.query<{
    id: string;
    numero: string;
    piece_technique_id: string;
    piece_code: string | null;
    piece_designation: string | null;
    statut: string;
    priority: string;
    quantite_lancee: number;
    quantite_bonne: number;
    quantite_rebut: number;
    total_ops: number;
    done_ops: number;
    date_lancement_prevue: string | null;
    date_fin_prevue: string | null;
    updated_at: string;
  }>(
    `
    SELECT
      o.id::text AS id,
      o.numero,
      o.piece_technique_id::text AS piece_technique_id,
      pt.code_piece AS piece_code,
      pt.designation AS piece_designation,
      o.statut::text AS statut,
      o.priority::text AS priority,
      o.quantite_lancee::float8 AS quantite_lancee,
      o.quantite_bonne::float8 AS quantite_bonne,
      o.quantite_rebut::float8 AS quantite_rebut,
      COALESCE(ops.total_ops, 0)::int AS total_ops,
      COALESCE(ops.done_ops, 0)::int AS done_ops,
      o.date_lancement_prevue::text AS date_lancement_prevue,
      o.date_fin_prevue::text AS date_fin_prevue,
      o.updated_at::text AS updated_at
    FROM ordres_fabrication o
    LEFT JOIN pieces_techniques pt ON pt.id = o.piece_technique_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_ops,
        COUNT(*) FILTER (WHERE op.status = 'DONE') AS done_ops
      FROM of_operations op
      WHERE op.of_id = o.id
    ) ops ON TRUE
    WHERE o.affaire_id = $1
    ORDER BY o.updated_at DESC, o.id DESC
    `,
    [id]
  );

  const livraisonsRes = await pool.query<{
    id: string;
    numero: string;
    statut: string;
    date_creation: string;
    date_expedition: string | null;
    date_livraison: string | null;
    transporteur: string | null;
    tracking_number: string | null;
    updated_at: string;
  }>(
    `
    SELECT
      id::text AS id,
      numero,
      statut,
      date_creation::text AS date_creation,
      date_expedition::text AS date_expedition,
      date_livraison::text AS date_livraison,
      transporteur,
      tracking_number,
      updated_at::text AS updated_at
    FROM bon_livraison
    WHERE affaire_id = $1
    ORDER BY updated_at DESC, numero DESC
    `,
    [id]
  );

  const facturesRes = await pool.query<{
    id: string;
    numero: string;
    statut: string;
    date_emission: string;
    date_echeance: string | null;
    total_ttc: number;
    paid_ttc: number;
    remaining_ttc: number;
    updated_at: string;
  }>(
    `
    SELECT
      f.id::text AS id,
      f.numero,
      f.statut,
      f.date_emission::text AS date_emission,
      f.date_echeance::text AS date_echeance,
      f.total_ttc::float8 AS total_ttc,
      pay.total_paye_ttc AS paid_ttc,
      GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc) AS remaining_ttc,
      f.updated_at::text AS updated_at
    FROM facture f
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(p.montant), 0)::float8 AS total_paye_ttc
      FROM paiement p
      WHERE p.facture_id = f.id
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.total_ttc), 0)::float8 AS total_avoirs_ttc
      FROM avoir a
      WHERE a.facture_id = f.id
        AND COALESCE(a.statut, '') <> 'brouillon'
    ) av ON TRUE
    WHERE f.affaire_id = $1
    ORDER BY f.updated_at DESC, f.id DESC
    `,
    [id]
  );

  const documentsRes = await pool.query<{
    source: "commande" | "livraison" | "facture";
    entity_id: string;
    document_id: string;
    type: string | null;
    document_name: string | null;
    created_at: string | null;
  }>(
    `
    SELECT 'commande'::text AS source, cd.commande_id::text AS entity_id, cd.document_id::text AS document_id,
           cd.type::text AS type, dc.document_name, NULL::text AS created_at
    FROM commande_documents cd
    LEFT JOIN documents_clients dc ON dc.id = cd.document_id
    WHERE cd.commande_id = $2::bigint
    UNION ALL
    SELECT 'livraison'::text AS source, bld.bon_livraison_id::text AS entity_id, bld.document_id::text AS document_id,
           bld.type, dc.document_name, bld.created_at::text AS created_at
    FROM bon_livraison_documents bld
    JOIN bon_livraison bl ON bl.id = bld.bon_livraison_id
    LEFT JOIN documents_clients dc ON dc.id = bld.document_id
    WHERE bl.affaire_id = $1::bigint
    UNION ALL
    SELECT 'facture'::text AS source, fd.facture_id::text AS entity_id, fd.document_id::text AS document_id,
           fd.type, dc.document_name, fd.created_at::text AS created_at
    FROM facture_documents fd
    JOIN facture f ON f.id = fd.facture_id
    LEFT JOIN documents_clients dc ON dc.id = fd.document_id
    WHERE f.affaire_id = $1::bigint
    ORDER BY created_at DESC NULLS LAST, source ASC
    `,
    [id, affaire.commande.id]
  );

  type TimelineRow = {
    source: "commande" | "livraison" | "audit";
    event_type: string;
    entity_type: string;
    entity_id: string;
    created_at: string;
    user_id: number | null;
    old_values: unknown | null;
    new_values: unknown | null;
    details: unknown | null;
  };

  const timelineRes = await pool.query<TimelineRow>(
    `
    SELECT 'commande'::text AS source,
           cel.event_type,
           'commande_client'::text AS entity_type,
           cel.commande_id::text AS entity_id,
           cel.created_at::text AS created_at,
           cel.user_id,
           cel.old_values,
           cel.new_values,
           NULL::jsonb AS details
    FROM commande_client_event_log cel
    WHERE cel.commande_id = $2::bigint
    UNION ALL
    SELECT 'livraison'::text AS source,
           ble.event_type,
           'bon_livraison'::text AS entity_type,
           ble.bon_livraison_id::text AS entity_id,
           ble.created_at::text AS created_at,
           ble.user_id,
           ble.old_values,
           ble.new_values,
           NULL::jsonb AS details
    FROM bon_livraison_event_log ble
    JOIN bon_livraison bl ON bl.id = ble.bon_livraison_id
    WHERE bl.affaire_id = $1::bigint
    UNION ALL
    SELECT 'audit'::text AS source,
           eal.action AS event_type,
           COALESCE(eal.entity_type, 'affaire') AS entity_type,
           COALESCE(eal.entity_id, $1::text) AS entity_id,
           eal.created_at::text AS created_at,
           eal.user_id,
           NULL::jsonb AS old_values,
           NULL::jsonb AS new_values,
           eal.details
    FROM erp_audit_logs eal
    WHERE (eal.entity_type = 'affaire' AND eal.entity_id = $1::text)
       OR (eal.entity_type = 'commande_client' AND eal.entity_id = $2::text)
    ORDER BY created_at DESC
    LIMIT 80
    `,
    [id, affaire.commande.id]
  );

  return {
    affaire,
    allocations: allocationsRes.rows.map((r) => ({
      id: toInt(r.id, "commande_ligne_affaire_allocation.id"),
      commande_ligne_id: toInt(r.commande_ligne_id, "commande_ligne_affaire_allocation.commande_ligne_id"),
      article_ref_id: r.article_ref_id,
      article_legacy_id: toNullableInt(r.article_legacy_id, "commande_ligne_affaire_allocation.article_legacy_id"),
      qty_ordered: Number(r.qty_ordered),
      qty_from_stock: Number(r.qty_from_stock),
      qty_reserved: Number(r.qty_reserved),
      qty_to_produce: Number(r.qty_to_produce),
      allocation_mode: r.allocation_mode,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    ordres_fabrication: ofsRes.rows.map((r) => ({
      ...r,
      id: toInt(r.id, "ordres_fabrication.id"),
      quantite_lancee: Number(r.quantite_lancee),
      quantite_bonne: Number(r.quantite_bonne),
      quantite_rebut: Number(r.quantite_rebut),
      total_ops: Number(r.total_ops),
      done_ops: Number(r.done_ops),
    })),
    livraisons: livraisonsRes.rows,
    factures: facturesRes.rows.map((r) => ({
      ...r,
      id: toInt(r.id, "facture.id"),
      total_ttc: Number(r.total_ttc),
      paid_ttc: Number(r.paid_ttc),
      remaining_ttc: Number(r.remaining_ttc),
    })),
    documents: documentsRes.rows,
    timeline: timelineRes.rows.map((r): AffaireTimelineEvent => ({
      source: r.source,
      event_type: r.event_type,
      title: `${r.entity_type} - ${r.event_type}`,
      occurred_at: r.created_at,
      actor_id: r.user_id,
      actor_name: null,
      source_id: r.entity_id,
      details: {
        entity_type: r.entity_type,
        old_values: r.old_values,
        new_values: r.new_values,
        ...(isRecord(r.details) ? r.details : r.details === null ? {} : { details: r.details }),
      },
    })),
  };
}

export async function repoCreateAffaire(input: CreateAffaireBodyDTO, audit?: AuditContext) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seqRes = await client.query<{ id: string }>(
      `SELECT nextval('public.affaire_id_seq')::bigint::text AS id`
    );
    const idRaw = seqRes.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate affaire id");
    const id = toInt(idRaw, "affaire.id");

    const reference = (input.reference ?? `AFF-${id}`).slice(0, 30);

    const insertSql = `
      INSERT INTO affaire (
        id,
        reference,
        client_id,
        commande_id,
        devis_id,
        type_affaire,
        statut,
        date_ouverture,
        date_cloture,
        commentaire
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        COALESCE($8::date, CURRENT_DATE),
        $9::date,
        $10
      )
      RETURNING id::text AS id
    `;

    const ins = await client.query<{ id: string }>(insertSql, [
      id,
      reference,
      input.client_id,
      input.commande_id ?? null,
      input.devis_id ?? null,
      input.type_affaire,
      input.statut,
      input.date_ouverture ?? null,
      input.date_cloture ?? null,
      input.commentaire ?? null,
    ]);

    const insertedId = ins.rows[0]?.id;
    const affaireId = insertedId ? toInt(insertedId, "affaire.id") : id;

    if (audit) {
      await insertAffaireAuditLog(client, audit, {
        action: "affaires.create",
        entity_id: String(affaireId),
        details: {
          reference,
          client_id: input.client_id,
          commande_id: input.commande_id ?? null,
          devis_id: input.devis_id ?? null,
          statut: input.statut,
          type_affaire: "livraison",
        },
      });
    }

    await client.query("COMMIT");
    return { id: affaireId };
  } catch (err) {
    await client.query("ROLLBACK");

    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "affaire_reference_key") {
      throw new HttpError(409, "AFFAIRE_REFERENCE_EXISTS", "Reference already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateAffaire(id: number, input: UpdateAffaireBodyDTO, audit?: AuditContext) {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (input.reference !== undefined) {
    sets.push(`reference = ${push(input.reference)}`);
  }
  if (input.client_id !== undefined) {
    sets.push(`client_id = ${push(input.client_id)}`);
  }
  if (input.commande_id !== undefined) {
    sets.push(`commande_id = ${push(input.commande_id)}::bigint`);
  }
  if (input.devis_id !== undefined) {
    sets.push(`devis_id = ${push(input.devis_id)}::bigint`);
  }
  if (input.type_affaire !== undefined) {
    sets.push(`type_affaire = ${push(input.type_affaire)}`);
  }
  if (input.date_ouverture !== undefined) {
    sets.push(`date_ouverture = ${push(input.date_ouverture)}::date`);
  }
  if (input.commentaire !== undefined) {
    sets.push(`commentaire = ${push(input.commentaire)}`);
  }

  if (input.statut !== undefined) {
    sets.push(`statut = ${push(input.statut)}`);
    if (input.statut === "CLOTUREE") {
      if (input.date_cloture) {
        sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
      } else {
        sets.push(`date_cloture = COALESCE(date_cloture, CURRENT_DATE)`);
      }
    } else if (input.date_cloture !== undefined) {
      sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
    }
  } else if (input.date_cloture !== undefined) {
    sets.push(`date_cloture = ${push(input.date_cloture)}::date`);
  }

  if (sets.length === 0) {
    return null;
  }

  sets.push(`updated_at = now()`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const beforeRes = await client.query<Record<string, unknown>>(
      `SELECT row_to_json(a.*) AS before FROM affaire a WHERE a.id = $1 FOR UPDATE`,
      [id]
    );
    const before = beforeRes.rows[0]?.before ?? null;
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }

    const sql = `
      UPDATE affaire
      SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id::text AS id
    `;

    const res = await client.query<{ id: string }>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    if (audit) {
      await insertAffaireAuditLog(client, audit, {
        action: "affaires.update",
        entity_id: String(id),
        details: {
          before,
          patch: input,
        },
      });
    }

    await client.query("COMMIT");
    return { id: toInt(row.id, "affaire.id") };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "affaire_reference_key") {
      throw new HttpError(409, "AFFAIRE_REFERENCE_EXISTS", "Reference already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteAffaire(id: number, audit?: AuditContext) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const beforeRes = await client.query<Record<string, unknown>>(
      `SELECT row_to_json(a.*) AS before FROM affaire a WHERE a.id = $1 FOR UPDATE`,
      [id]
    );
    const before = beforeRes.rows[0]?.before ?? null;
    if (!before) {
      await client.query("ROLLBACK");
      return false;
    }

    const links = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM commande_to_affaire WHERE affaire_id = $1`,
      [id]
    );
    const mappingCount = links.rows[0]?.count ?? 0;

    await client.query(`DELETE FROM commande_to_affaire WHERE affaire_id = $1`, [id]);
    const del = await client.query(`DELETE FROM affaire WHERE id = $1`, [id]);

    if ((del.rowCount ?? 0) > 0 && audit) {
      await insertAffaireAuditLog(client, audit, {
        action: "affaires.delete",
        entity_id: String(id),
        details: {
          before,
          deleted_commande_mappings: mappingCount,
        },
      });
    }

    await client.query("COMMIT");
    return (del.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
