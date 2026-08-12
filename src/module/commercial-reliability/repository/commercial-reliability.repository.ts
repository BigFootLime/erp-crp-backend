import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import {
  repoClients,
  repoOrders,
  repoQuotes,
  repoReceivables,
  type ReportingContext,
} from "../../facturation/repository/reporting-v2.repository";
import { normalizeCommandeWorkflowStatus } from "../../commande-client/workflow/commande-client-workflow.definition";
import {
  COMMERCIAL_CONTRACT_VERSION,
  COMMERCIAL_TIMEZONE,
  commercialPayloadHash,
  conversionRate,
  effectiveDiscountPct,
  qualifyCommercialRisk,
} from "../domain/commercial-reliability";
import type {
  CancelOrderBodyDTO,
  CommercialOverviewQueryDTO,
  DiscountDecisionBodyDTO,
  DiscountRequestBodyDTO,
  ExpireDueQuotesBodyDTO,
  QuoteLossBodyDTO,
  QuoteReminderBodyDTO,
} from "../validators/commercial-reliability.validators";

type Queryer = Pick<PoolClient, "query">;

export type CommercialActor = {
  user_id: number;
  role: string | null;
  ip: string | null;
  user_agent: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type CommandAction =
  | "QUOTE_REMINDER"
  | "QUOTE_LOSS"
  | "DISCOUNT_REQUEST"
  | "DISCOUNT_DECISION"
  | "EXPIRE_DUE_QUOTES"
  | "ORDER_CANCEL";

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function insertAudit(
  tx: Queryer,
  actor: CommercialActor,
  entry: { action: string; entity_type: string; entity_id: string; details: Record<string, unknown> },
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: actor.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: actor.path,
    client_session_id: actor.client_session_id,
    details: entry.details,
  };
  await repoInsertAuditLog({
    user_id: actor.user_id,
    body,
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: null,
    os: null,
    browser: null,
    tx,
  });
}

async function readReceipt<T>(
  tx: Queryer,
  action: CommandAction,
  idempotencyKey: string,
  requestHash: string,
): Promise<T | null> {
  const result = await tx.query<{ request_hash: string; response_snapshot: T }>(
    `SELECT request_hash, response_snapshot
     FROM public.commercial_command_receipts
     WHERE action=$1 AND idempotency_key=$2
     FOR SHARE`,
    [action, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Cette clé d'idempotence a déjà été utilisée avec une demande différente.",
    );
  }
  return { ...row.response_snapshot, idempotent_replay: true } as T;
}

async function saveReceipt(
  tx: Queryer,
  action: CommandAction,
  idempotencyKey: string,
  requestHash: string,
  actorUserId: number,
  response: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO public.commercial_command_receipts
       (action,idempotency_key,request_hash,actor_user_id,response_snapshot)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [action, idempotencyKey, requestHash, actorUserId, JSON.stringify(response)],
  );
}

type QuoteSnapshot = {
  id: number;
  numero: string;
  statut: string;
  owner_user_id: number | null;
  date_validite: string | null;
  total_ht: number;
  gross_ht: number;
  content_hash: string;
  discount_pct: number | null;
};

async function loadQuoteSnapshot(tx: Queryer, devisId: number, lock = false): Promise<QuoteSnapshot | null> {
  const header = await tx.query<{
    id: string;
    numero: string;
    statut: string;
    owner_user_id: number | null;
    date_validite: string | null;
    total_ht: number;
    remise_globale: number;
  }>(
    `SELECT d.id::text AS id,d.numero,d.statut,d.user_id AS owner_user_id,
            d.date_validite::text,d.total_ht::float8 AS total_ht,d.remise_globale::float8 AS remise_globale
     FROM public.devis d WHERE d.id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [devisId],
  );
  const row = header.rows[0];
  if (!row) return null;
  const lines = await tx.query<{
    id: string;
    quantite: number;
    prix_unitaire_ht: number;
    remise_ligne: number | null;
    taux_tva: number | null;
  }>(
    `SELECT id::text,quantite::float8,prix_unitaire_ht::float8,
            remise_ligne::float8,taux_tva::float8
     FROM public.devis_ligne WHERE devis_id=$1 ORDER BY id`,
    [devisId],
  );
  const grossHt = lines.rows.reduce((sum, line) => sum + line.quantite * line.prix_unitaire_ht, 0);
  const contentHash = commercialPayloadHash({
    devis_id: devisId,
    remise_globale: row.remise_globale,
    lignes: lines.rows,
  });
  return {
    id: Number(row.id),
    numero: row.numero,
    statut: row.statut,
    owner_user_id: row.owner_user_id,
    date_validite: row.date_validite,
    total_ht: row.total_ht,
    gross_ht: grossHt,
    content_hash: contentHash,
    discount_pct: effectiveDiscountPct({ grossAmountHt: grossHt, netAmountHt: row.total_ht }),
  };
}

/** Called by the canonical devis transition before BROUILLON -> ENVOYE. */
export async function assertQuoteDiscountApprovedForSubmission(tx: Queryer, devisId: number): Promise<void> {
  const quote = await loadQuoteSnapshot(tx, devisId, false);
  if (!quote) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
  if (quote.discount_pct === null) {
    throw new HttpError(409, "QUOTE_DISCOUNT_UNQUALIFIED", "La remise effective ne peut pas être calculée.");
  }
  if (quote.discount_pct <= 0) return;
  const approval = await tx.query<{ approved: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.commercial_quote_events e
       WHERE e.devis_id=$1 AND e.event_type='DISCOUNT_APPROVED'
         AND e.quote_content_hash=$2
     ) AS approved`,
    [devisId, quote.content_hash],
  );
  if (approval.rows[0]?.approved !== true) {
    throw new HttpError(
      409,
      "QUOTE_DISCOUNT_APPROVAL_REQUIRED",
      "Ce devis contient une remise. Faites valider cette version avant l'envoi.",
      { devis_id: devisId, discount_pct: quote.discount_pct, quote_content_hash: quote.content_hash },
    );
  }
}

function reportingContext(query: CommercialOverviewQueryDTO): ReportingContext {
  return {
    period: { from: query.from, to: query.to },
    asOf: query.as_of ?? query.to,
    basis: "document_date",
    granularity: "month",
    clientId: query.client_id,
    currency: query.currency,
    commercialId: query.commercial_id,
    limit: query.limit,
  };
}

async function repoCommercialDetails(query: CommercialOverviewQueryDTO) {
  const values: unknown[] = [query.from, query.to, query.as_of ?? query.to];
  const clientFilter = query.client_id ? `AND d.client_id=$${values.push(query.client_id)}` : "";
  const currencyFilter = query.currency
    ? `AND EXISTS (
         SELECT 1 FROM public.clients currency_client
         WHERE currency_client.client_id=d.client_id
           AND UPPER(COALESCE(NULLIF(BTRIM(currency_client.devise),''),'EUR'))=$${values.push(query.currency)}
       )`
    : "";
  const commercialFilter = query.commercial_id ? `AND d.user_id=$${values.push(query.commercial_id)}` : "";
  const result = await pool.query<{
    cohorts: unknown;
    loss_reasons: unknown;
    response_days_avg: number | null;
    event_coverage_count: number;
    eligible_count: number;
    margin_complete_count: number;
    margin_partial_count: number;
    margin_gross_ht: string | null;
    converted_count: number;
  }>(
    `WITH latest_order_status AS (
       SELECT DISTINCT ON (ch.commande_id) ch.commande_id,ch.nouveau_statut
       FROM public.commande_historique ch
       ORDER BY ch.commande_id,ch.date_action DESC,ch.id DESC
     ), scoped AS (
       SELECT d.*,
         (SELECT MIN(e.occurred_at) FROM public.commercial_quote_events e
          WHERE e.devis_id=d.id AND e.event_type='SENT') AS sent_at,
         (SELECT MIN(e.occurred_at) FROM public.commercial_quote_events e
          WHERE e.devis_id=d.id AND e.event_type IN ('ACCEPTED','LOST')) AS decided_at,
         EXISTS (
           SELECT 1
           FROM public.commande_client cc
           LEFT JOIN latest_order_status los ON los.commande_id=cc.id
           WHERE (cc.devis_id=d.id OR cc.source_devis_version_id=d.id)
             AND COALESCE(los.nouveau_statut,'BROUILLON') <> 'ANNULE'
         ) AS converted
       FROM public.devis d
       WHERE d.date_creation BETWEEN $1::date AND $2::date
         AND d.statut NOT IN ('BROUILLON','ANNULE') ${clientFilter} ${currencyFilter} ${commercialFilter}
         AND NOT EXISTS (
           SELECT 1 FROM public.devis newer_quote
           WHERE COALESCE(newer_quote.root_devis_id,newer_quote.id)=COALESCE(d.root_devis_id,d.id)
             AND (newer_quote.version_number>d.version_number
               OR (newer_quote.version_number=d.version_number AND newer_quote.id>d.id))
         )
     ), latest_margin AS (
       SELECT DISTINCT ON (m.scope_ref) m.scope_ref,m.result_snapshot
       FROM public.margin_recalculations m
       JOIN scoped s ON s.id::text=m.scope_ref
       WHERE m.scope_type='DEVIS' AND m.basis='QUOTED' AND m.as_of <= $3::date
       ORDER BY m.scope_ref,m.created_at DESC,m.id DESC
     ), cohorts AS (
       SELECT date_trunc('month',COALESCE(sent_at,date_creation::timestamptz))::date::text AS cohort,
               COUNT(*)::int AS issued,
               COUNT(*) FILTER (WHERE statut IN ('ACCEPTE','REFUSE'))::int AS decided,
               COUNT(*) FILTER (WHERE statut='ACCEPTE')::int AS won,
               COUNT(*) FILTER (WHERE converted)::int AS converted
       FROM scoped GROUP BY 1 ORDER BY 1
     ), losses AS (
       SELECT e.reason_code,COUNT(*)::int AS count
       FROM public.commercial_quote_events e JOIN scoped s ON s.id=e.devis_id
       WHERE e.event_type='LOST' GROUP BY e.reason_code ORDER BY count DESC,e.reason_code
     )
     SELECT
       COALESCE((SELECT json_agg(json_build_object(
         'cohort',cohort,'issued',issued,'decided',decided,'won',won,'converted',converted,
         'conversion_rate_pct',CASE WHEN issued=0 THEN NULL ELSE round(converted::numeric/issued*100,4) END
       )) FROM cohorts),'[]'::json) AS cohorts,
       COALESCE((SELECT json_agg(losses) FROM losses),'[]'::json) AS loss_reasons,
       (SELECT AVG(EXTRACT(EPOCH FROM (decided_at-sent_at))/86400)::float8
        FROM scoped WHERE sent_at IS NOT NULL AND decided_at IS NOT NULL AND decided_at>=sent_at) AS response_days_avg,
       (SELECT COUNT(*) FROM scoped WHERE sent_at IS NOT NULL)::int AS event_coverage_count,
        (SELECT COUNT(*) FROM scoped)::int AS eligible_count,
        (SELECT COUNT(*) FROM scoped WHERE converted)::int AS converted_count,
       (SELECT COUNT(*) FROM latest_margin WHERE result_snapshot->>'availability'='COMPLETE')::int AS margin_complete_count,
       ((SELECT COUNT(*) FROM scoped)-
        (SELECT COUNT(*) FROM latest_margin
         WHERE result_snapshot->>'availability'='COMPLETE'
           AND result_snapshot->>'gross_margin_ht' IS NOT NULL))::int AS margin_partial_count,
       (SELECT CASE
          WHEN (SELECT COUNT(*) FROM scoped)=0 THEN NULL
          WHEN (SELECT COUNT(*) FROM latest_margin WHERE result_snapshot->>'availability'='COMPLETE')=(SELECT COUNT(*) FROM scoped)
          THEN SUM((result_snapshot->>'gross_margin_ht')::numeric)::numeric(18,2)::text
          ELSE NULL END FROM latest_margin) AS margin_gross_ht`,
    values,
  );
  return result.rows[0];
}

async function repoCommercialCurrencies(query: CommercialOverviewQueryDTO): Promise<string[]> {
  if (query.currency) return [query.currency];
  const result = await pool.query<{ currency: string }>(
    `WITH currencies AS (
       SELECT UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR')) AS currency
       FROM public.devis d JOIN public.clients c ON c.client_id=d.client_id
       WHERE d.date_creation BETWEEN $1::date AND $2::date
          AND d.statut NOT IN ('BROUILLON','ANNULE')
          AND NOT EXISTS (
            SELECT 1 FROM public.devis newer_quote
            WHERE COALESCE(newer_quote.root_devis_id,newer_quote.id)=COALESCE(d.root_devis_id,d.id)
              AND (newer_quote.version_number>d.version_number
                OR (newer_quote.version_number=d.version_number AND newer_quote.id>d.id))
          )
         AND ($3::text IS NULL OR d.client_id=$3)
         AND ($4::integer IS NULL OR d.user_id=$4)
       UNION
       SELECT UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))
       FROM public.commande_client cc JOIN public.clients c ON c.client_id=cc.client_id
       WHERE cc.date_commande BETWEEN $1::date AND $2::date
         AND ($3::text IS NULL OR cc.client_id=$3)
       UNION
       SELECT UPPER(COALESCE(NULLIF(BTRIM(f.currency),''),'EUR'))
       FROM public.facture f
       WHERE f.date_emission BETWEEN $1::date AND $2::date
         AND f.statut NOT IN ('DRAFT','CANCELLED','brouillon','annule','annulee')
         AND ($3::text IS NULL OR f.client_id=$3)
       UNION
       SELECT UPPER(COALESCE(NULLIF(BTRIM(a.currency),''),'EUR'))
       FROM public.avoir a
       WHERE a.date_emission BETWEEN $1::date AND $2::date
         AND a.statut NOT IN ('DRAFT','CANCELLED','brouillon','annule','annulee')
         AND ($3::text IS NULL OR a.client_id=$3)
     )
     SELECT currency FROM currencies WHERE currency IS NOT NULL ORDER BY currency`,
    [query.from, query.to, query.client_id ?? null, query.commercial_id ?? null],
  );
  return result.rows.map((row) => row.currency);
}

async function repoCommercialActivityClients(query: CommercialOverviewQueryDTO) {
  const limit = query.limit + 1;
  const result = await pool.query<{ client_id: string; company_name: string | null }>(
    `WITH latest_order_status AS (
       SELECT DISTINCT ON (ch.commande_id) ch.commande_id,ch.nouveau_statut
       FROM public.commande_historique ch
       ORDER BY ch.commande_id,ch.date_action DESC,ch.id DESC
     ), activity AS (
       SELECT d.client_id
       FROM public.devis d
       WHERE d.date_creation BETWEEN $1::date AND $2::date
         AND d.statut NOT IN ('BROUILLON','ANNULE')
         AND NOT EXISTS (
           SELECT 1 FROM public.devis newer_quote
           WHERE COALESCE(newer_quote.root_devis_id,newer_quote.id)=COALESCE(d.root_devis_id,d.id)
             AND (newer_quote.version_number>d.version_number
               OR (newer_quote.version_number=d.version_number AND newer_quote.id>d.id))
         )
         AND ($3::integer IS NULL OR d.user_id=$3)
       UNION
       SELECT cc.client_id
       FROM public.commande_client cc
       LEFT JOIN latest_order_status los ON los.commande_id=cc.id
       WHERE cc.date_commande BETWEEN $1::date AND $2::date
         AND COALESCE(cc.order_type,'FERME') <> 'INTERNE'
         AND COALESCE(los.nouveau_statut,'BROUILLON') <> 'ANNULE'
         AND ($3::integer IS NULL OR cc.created_by=$3)
       UNION
       SELECT $4::text WHERE $4::text IS NOT NULL AND $3::integer IS NULL
     )
     SELECT c.client_id,c.company_name
     FROM activity a
     JOIN public.clients c ON c.client_id=a.client_id
     WHERE ($4::text IS NULL OR c.client_id=$4)
       AND ($5::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$5)
     ORDER BY c.company_name NULLS LAST,c.client_id
     LIMIT $6`,
    [query.from, query.to, query.commercial_id ?? null, query.client_id ?? null, query.currency ?? null, limit],
  );
  return {
    items: result.rows.slice(0, query.limit),
    truncated: result.rows.length > query.limit,
  };
}

type ClientQualification = {
  client_id: string;
  client_blocked: boolean;
  quote_count: number;
  decided_count: number;
  won_count: number;
  converted_count: number;
  expired_open_quotes: number;
  margin_complete_count: number;
  qualified_margin_ht: string | null;
  blocked_orders: number;
  overdue_backlog_ht: string;
};

async function repoClientQualifications(query: CommercialOverviewQueryDTO, clientIds: string[]) {
  if (clientIds.length === 0) return new Map<string, ClientQualification>();
  const result = await pool.query<ClientQualification>(
    `WITH latest_status AS (
       SELECT DISTINCT ON (ch.commande_id) ch.commande_id,ch.nouveau_statut
       FROM public.commande_historique ch
       ORDER BY ch.commande_id,ch.date_action DESC,ch.id DESC
     ), shipped AS (
       SELECT bll.commande_ligne_id,SUM(bll.quantite)::numeric AS qty
       FROM public.bon_livraison_ligne bll
       JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
       WHERE bl.statut IN ('SHIPPED','DELIVERED')
         AND COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation) <= $4::date
       GROUP BY bll.commande_ligne_id
     ), open_lines AS (
       SELECT cc.client_id,cc.id AS commande_id,COALESCE(ls.nouveau_statut,'BROUILLON') AS workflow_status,
              cl.delai_client,
              GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)::numeric AS remaining_qty,
              (GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)*cl.prix_unitaire_ht*(1-COALESCE(cl.remise_ligne,0)/100))::numeric(18,2) AS remaining_ht
       FROM public.commande_ligne cl
       JOIN public.commande_client cc ON cc.id=cl.commande_id
       JOIN public.clients c ON c.client_id=cc.client_id
       LEFT JOIN shipped ON shipped.commande_ligne_id=cl.id
       LEFT JOIN latest_status ls ON ls.commande_id=cc.id
       WHERE cc.client_id=ANY($1::text[])
         AND COALESCE(cc.order_type,'FERME') <> 'INTERNE'
         AND COALESCE(ls.nouveau_statut,'BROUILLON') <> 'ANNULE'
         AND ($5::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$5)
     ), order_facts AS (
       SELECT client_id,
              COUNT(DISTINCT commande_id) FILTER (WHERE workflow_status='BLOQUE')::int AS blocked_orders,
              COALESCE(SUM(remaining_ht) FILTER (
                WHERE remaining_qty>0 AND delai_client IS NOT NULL AND delai_client<$4::date
              ),0)::numeric(18,2)::text AS overdue_backlog_ht
       FROM open_lines GROUP BY client_id
     ), scoped_quotes AS (
        SELECT d.id,d.client_id,d.statut,d.date_validite,
               EXISTS (
                 SELECT 1
                 FROM public.commande_client cc
                 LEFT JOIN latest_status conversion_status ON conversion_status.commande_id=cc.id
                 WHERE (cc.devis_id=d.id OR cc.source_devis_version_id=d.id)
                   AND COALESCE(conversion_status.nouveau_statut,'BROUILLON') <> 'ANNULE'
               ) AS converted
       FROM public.devis d
       JOIN public.clients c ON c.client_id=d.client_id
       WHERE d.client_id=ANY($1::text[])
         AND d.date_creation BETWEEN $2::date AND $3::date
         AND d.statut NOT IN ('BROUILLON','ANNULE')
         AND NOT EXISTS (
           SELECT 1 FROM public.devis newer_quote
           WHERE COALESCE(newer_quote.root_devis_id,newer_quote.id)=COALESCE(d.root_devis_id,d.id)
             AND (newer_quote.version_number>d.version_number
               OR (newer_quote.version_number=d.version_number AND newer_quote.id>d.id))
         )
         AND ($5::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$5)
         AND ($6::integer IS NULL OR d.user_id=$6)
     ), latest_margin AS (
       SELECT DISTINCT ON (m.scope_ref) m.scope_ref,m.result_snapshot
       FROM public.margin_recalculations m
       JOIN scoped_quotes q ON q.id::text=m.scope_ref
       WHERE m.scope_type='DEVIS' AND m.basis='QUOTED' AND m.as_of <= $4::date
       ORDER BY m.scope_ref,m.created_at DESC,m.id DESC
     ), quote_facts AS (
       SELECT q.client_id,
              COUNT(*)::int AS quote_count,
               COUNT(*) FILTER (WHERE q.statut IN ('ACCEPTE','REFUSE'))::int AS decided_count,
               COUNT(*) FILTER (WHERE q.statut='ACCEPTE')::int AS won_count,
               COUNT(*) FILTER (WHERE q.converted)::int AS converted_count,
              COUNT(*) FILTER (WHERE q.statut='ENVOYE' AND q.date_validite<$4::date)::int AS expired_open_quotes,
              COUNT(*) FILTER (
                WHERE lm.result_snapshot->>'availability'='COMPLETE'
                  AND lm.result_snapshot->>'gross_margin_ht' IS NOT NULL
              )::int AS margin_complete_count,
              CASE WHEN COUNT(*)>0 AND COUNT(*) FILTER (
                       WHERE lm.result_snapshot->>'availability'='COMPLETE'
                         AND lm.result_snapshot->>'gross_margin_ht' IS NOT NULL
                     )=COUNT(*)
                   THEN SUM((lm.result_snapshot->>'gross_margin_ht')::numeric)::numeric(18,2)::text
                   ELSE NULL END AS qualified_margin_ht
       FROM scoped_quotes q LEFT JOIN latest_margin lm ON lm.scope_ref=q.id::text
       GROUP BY q.client_id
     )
     SELECT c.client_id,c.blocked AS client_blocked,
            COALESCE(q.quote_count,0)::int AS quote_count,
             COALESCE(q.decided_count,0)::int AS decided_count,
             COALESCE(q.won_count,0)::int AS won_count,
             COALESCE(q.converted_count,0)::int AS converted_count,
            COALESCE(q.expired_open_quotes,0)::int AS expired_open_quotes,
            COALESCE(q.margin_complete_count,0)::int AS margin_complete_count,
            q.qualified_margin_ht,
            COALESCE(o.blocked_orders,0)::int AS blocked_orders,
            COALESCE(o.overdue_backlog_ht,'0.00')::text AS overdue_backlog_ht
     FROM public.clients c
     LEFT JOIN quote_facts q ON q.client_id=c.client_id
     LEFT JOIN order_facts o ON o.client_id=c.client_id
     WHERE c.client_id=ANY($1::text[])`,
    [clientIds, query.from, query.to, query.as_of ?? query.to, query.currency ?? null, query.commercial_id ?? null],
  );
  return new Map(result.rows.map((row) => [row.client_id, row]));
}

async function repoCommercialExceptions(query: CommercialOverviewQueryDTO) {
  const asOf = query.as_of ?? query.to;
  const result = await pool.query(
    `WITH latest_status AS (
       SELECT DISTINCT ON (ch.commande_id) ch.commande_id,ch.nouveau_statut
       FROM public.commande_historique ch
       ORDER BY ch.commande_id,ch.date_action DESC,ch.id DESC
     ), shipped AS (
       SELECT bll.commande_ligne_id,SUM(bll.quantite)::numeric AS qty
       FROM public.bon_livraison_ligne bll
       JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
       WHERE bl.statut IN ('SHIPPED','DELIVERED')
         AND COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation) <= $1::date
       GROUP BY bll.commande_ligne_id
     ), open_lines AS (
       SELECT cc.id AS commande_id,cc.numero,cc.client_id,cc.created_by AS owner_user_id,cl.delai_client,
              GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)::numeric AS remaining_qty,
              (GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)*cl.prix_unitaire_ht*(1-COALESCE(cl.remise_ligne,0)/100))::numeric(18,2) AS remaining_ht,
              COALESCE(ls.nouveau_statut,'BROUILLON') AS workflow_status
       FROM public.commande_ligne cl
       JOIN public.commande_client cc ON cc.id=cl.commande_id
       JOIN public.clients c ON c.client_id=cc.client_id
       LEFT JOIN shipped ON shipped.commande_ligne_id=cl.id
       LEFT JOIN latest_status ls ON ls.commande_id=cc.id
       WHERE COALESCE(ls.nouveau_statut,'BROUILLON') <> 'ANNULE'
         AND ($2::text IS NULL OR cc.client_id=$2)
         AND ($4::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$4)
         AND ($5::integer IS NULL OR cc.created_by=$5)
     ), raw AS (
       SELECT 'QUOTE_EXPIRED'::text AS code,'HIGH'::text AS priority,'DEVIS'::text AS entity_type,
              d.id::text AS entity_id,d.numero AS label,d.user_id AS owner_user_id,
              'Requalifier le devis ou enregistrer le motif de perte.'::text AS next_action,
              jsonb_build_object('date_validite',d.date_validite,'source','devis.date_validite') AS evidence
       FROM public.devis d
       JOIN public.clients c ON c.client_id=d.client_id
        WHERE d.statut='ENVOYE' AND d.date_validite<$1::date
          AND NOT EXISTS (
            SELECT 1 FROM public.devis newer_quote
            WHERE COALESCE(newer_quote.root_devis_id,newer_quote.id)=COALESCE(d.root_devis_id,d.id)
              AND (newer_quote.version_number>d.version_number
                OR (newer_quote.version_number=d.version_number AND newer_quote.id>d.id))
          )
         AND ($2::text IS NULL OR d.client_id=$2)
         AND ($4::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$4)
         AND ($5::integer IS NULL OR d.user_id=$5)
       UNION ALL
       SELECT 'ORDER_BLOCKED','HIGH','COMMANDE',ol.commande_id::text,ol.numero,ol.owner_user_id,
              'Traiter le motif du checkpoint bloqué.',
              jsonb_build_object('status','BLOQUE','source','commande_historique')
       FROM open_lines ol WHERE ol.workflow_status='BLOQUE' GROUP BY ol.commande_id,ol.numero,ol.owner_user_id
       UNION ALL
       SELECT 'ORDER_PROMISE_MISSING','MEDIUM','COMMANDE',ol.commande_id::text,ol.numero,ol.owner_user_id,
              'Renseigner la date promise sur les lignes ouvertes.',
              jsonb_build_object('undated_lines',COUNT(*),'source','commande_ligne.delai_client')
       FROM open_lines ol WHERE ol.remaining_qty>0 AND ol.delai_client IS NULL GROUP BY ol.commande_id,ol.numero,ol.owner_user_id
       UNION ALL
       SELECT 'ORDER_OVERDUE','HIGH','COMMANDE',ol.commande_id::text,ol.numero,ol.owner_user_id,
              'Replanifier ou confirmer une nouvelle promesse au client.',
              jsonb_build_object('overdue_ht',SUM(ol.remaining_ht),'earliest_due',MIN(ol.delai_client),'source','commande_ligne + bon_livraison_ligne')
       FROM open_lines ol WHERE ol.remaining_qty>0 AND ol.delai_client<$1::date GROUP BY ol.commande_id,ol.numero,ol.owner_user_id
     )
     SELECT * FROM raw ORDER BY CASE priority WHEN 'HIGH' THEN 1 ELSE 2 END,code,entity_id LIMIT $3`,
    [asOf, query.client_id ?? null, query.limit, query.currency ?? null, query.commercial_id ?? null],
  );
  return result.rows;
}

async function repoOrderAging(query: CommercialOverviewQueryDTO) {
  const asOf = query.as_of ?? query.to;
  const result = await pool.query<{ bucket: string; count: number; amount_ht: string }>(
    `WITH latest_status AS (
       SELECT DISTINCT ON (ch.commande_id) ch.commande_id,ch.nouveau_statut
       FROM public.commande_historique ch
       ORDER BY ch.commande_id,ch.date_action DESC,ch.id DESC
     ), shipped AS (
       SELECT bll.commande_ligne_id,SUM(bll.quantite)::numeric AS qty
       FROM public.bon_livraison_ligne bll
       JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
       WHERE bl.statut IN ('SHIPPED','DELIVERED')
         AND COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation) <= $1::date
       GROUP BY bll.commande_ligne_id
     ), open_lines AS (
       SELECT cc.id AS commande_id,cl.delai_client,
              GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)::numeric AS remaining_qty,
              (GREATEST(cl.quantite-COALESCE(shipped.qty,0),0)*cl.prix_unitaire_ht*(1-COALESCE(cl.remise_ligne,0)/100))::numeric(18,2) AS remaining_ht
       FROM public.commande_ligne cl
       JOIN public.commande_client cc ON cc.id=cl.commande_id
       JOIN public.clients c ON c.client_id=cc.client_id
       LEFT JOIN shipped ON shipped.commande_ligne_id=cl.id
       LEFT JOIN latest_status ls ON ls.commande_id=cc.id
       WHERE COALESCE(cc.order_type,'FERME') <> 'INTERNE'
         AND COALESCE(ls.nouveau_statut,'BROUILLON') <> 'ANNULE'
         AND ($2::text IS NULL OR cc.client_id=$2)
         AND ($3::text IS NULL OR UPPER(COALESCE(NULLIF(BTRIM(c.devise),''),'EUR'))=$3)
         AND ($4::integer IS NULL OR cc.created_by=$4)
     ), per_order AS (
       SELECT commande_id,MIN(delai_client) AS earliest_due,SUM(remaining_ht)::numeric(18,2) AS amount_ht
       FROM open_lines WHERE remaining_qty>0 GROUP BY commande_id
     ), bucketed AS (
       SELECT CASE
         WHEN earliest_due IS NULL THEN 'UNDATED'
         WHEN earliest_due >= $1::date THEN 'NOT_DUE'
         WHEN $1::date-earliest_due <= 30 THEN '1_30'
         WHEN $1::date-earliest_due <= 60 THEN '31_60'
         WHEN $1::date-earliest_due <= 90 THEN '61_90'
         ELSE '90_PLUS' END AS bucket,amount_ht
       FROM per_order
     )
     SELECT bucket,COUNT(*)::int AS count,SUM(amount_ht)::numeric(18,2)::text AS amount_ht
     FROM bucketed GROUP BY bucket`,
    [asOf, query.client_id ?? null, query.currency ?? null, query.commercial_id ?? null],
  );
  const buckets = new Map(result.rows.map((row) => [row.bucket, row]));
  return ["NOT_DUE", "1_30", "31_60", "61_90", "90_PLUS", "UNDATED"].map((key) => ({
    key,
    count: toNumber(buckets.get(key)?.count),
    amount_ht: toNumber(buckets.get(key)?.amount_ht),
    truncated_source: false,
  }));
}

export async function repoCommercialOverview(query: CommercialOverviewQueryDTO) {
  const detectedCurrencies = await repoCommercialCurrencies(query);
  if (!query.currency && detectedCurrencies.length > 1) {
    throw new HttpError(
      409,
      "COMMERCIAL_CURRENCY_REQUIRED",
      "Plusieurs devises sont présentes. Sélectionnez une devise pour obtenir des montants comparables.",
      { currencies: detectedCurrencies },
    );
  }
  const effectiveQuery = query.currency || detectedCurrencies.length === 0
    ? query
    : { ...query, currency: detectedCurrencies[0] };
  const ctx = reportingContext(effectiveQuery);
  const [clients, quotes, orders, receivables, details, exceptions, aging, activityClients] = await Promise.all([
    repoClients(ctx),
    repoQuotes(ctx),
    repoOrders(ctx),
    repoReceivables(ctx),
    repoCommercialDetails(effectiveQuery),
    repoCommercialExceptions(effectiveQuery),
    repoOrderAging(effectiveQuery),
    repoCommercialActivityClients(effectiveQuery),
  ]);

  const cohorts = (Array.isArray(details?.cohorts) ? details.cohorts : []) as Array<Record<string, unknown>>;
  const baseClientIds = new Set(clients.items.map((client) => client.client_id));
  const activityOnlyClients = activityClients.items
    .filter((client) => !baseClientIds.has(client.client_id))
    .map((client) => ({
      ...client,
      net_ht: 0,
      net_ttc: 0,
      invoice_count: 0,
      credit_count: 0,
      share: clients.net_ht_total > 0 ? 0 : null,
      open_ttc: 0,
      overdue_ttc: 0,
    }));
  const combinedCandidateCount = clients.items.length + activityOnlyClients.length;
  const combinedClientItems = clients.truncated
    ? clients.items
    : [...clients.items, ...activityOnlyClients].slice(0, effectiveQuery.limit);
  const qualifications = await repoClientQualifications(effectiveQuery, combinedClientItems.map((client) => client.client_id));
  const clientItems = combinedClientItems.map((client) => {
    const qualification = qualifications.get(client.client_id);
    const quoteCount = toNumber(qualification?.quote_count);
    const completeMargins = toNumber(qualification?.margin_complete_count);
    const marginComplete = quoteCount > 0 && completeMargins === quoteCount;
    return {
      ...client,
      qualified_margin: {
        amount_ht: marginComplete ? toNumber(qualification?.qualified_margin_ht) : null,
        reliability: (marginComplete ? "ESTIMATED" : "PARTIAL") as "ESTIMATED" | "PARTIAL",
        coverage: { complete_quotes: completeMargins, eligible_quotes: quoteCount },
        reason: marginComplete
          ? "Tous les devis du périmètre disposent d'un snapshot QUOTED complet."
          : "Marge masquée : au moins un devis ne dispose pas d'un snapshot QUOTED complet.",
      },
      quote_to_order_conversion: {
        value_pct: conversionRate(toNumber(qualification?.converted_count), quoteCount),
        reliability: (quoteCount > 0 ? "ACTUAL" : "PARTIAL") as "ACTUAL" | "PARTIAL",
        numerator: toNumber(qualification?.converted_count),
        denominator: quoteCount,
        reason: quoteCount > 0 ? null : "Aucun devis émis dans la cohorte.",
      },
      risk: qualifyCommercialRisk({
        clientBlocked: qualification?.client_blocked === true,
        overdueReceivablesTtc: client.overdue_ttc,
        overdueBacklogHt: toNumber(qualification?.overdue_backlog_ht),
        blockedOrders: toNumber(qualification?.blocked_orders),
        expiredOpenQuotes: toNumber(qualification?.expired_open_quotes),
      }),
    };
  });

  return {
    envelope: {
      contract_version: COMMERCIAL_CONTRACT_VERSION,
      period: { from: effectiveQuery.from, to: effectiveQuery.to },
      as_of: ctx.asOf,
      timezone: COMMERCIAL_TIMEZONE,
      currency: effectiveQuery.currency ?? null,
      generated_at: new Date().toISOString(),
      source: "live" as const,
      freshness: { measured_at: new Date().toISOString(), max_age_seconds: 0 },
      reliability: (toNumber(details?.event_coverage_count) === toNumber(details?.eligible_count) ? "ACTUAL" : "PARTIAL") as "ACTUAL" | "PARTIAL",
      limitations: [
        "Le chiffre d'affaires affiché est le facturé net HT opérationnel, pas un état comptable certifié.",
        "Les délais de réponse historiques restent indisponibles pour les devis sans événement SENT/decision horodaté.",
        "Les montants sont limités à une seule devise ; une requête multi-devises est refusée.",
      ],
    },
    clients: {
      definition: "Facturé net HT, encours TTC et risque catégoriel à la date d'arrêté.",
      unit: "currency / percent / category",
      source: ["facture", "avoir", "paiement", "devis", "commande_historique"],
      data: {
        ...clients,
        client_count: clients.truncated ? clients.client_count : clientItems.length,
        items: clientItems,
        truncated: clients.truncated || activityClients.truncated || combinedCandidateCount > effectiveQuery.limit,
      },
    },
    quotes: {
      definition: "Cohorte du premier envoi connu; conversion = devis reliés à une commande non annulée / devis émis.",
      unit: "count / currency / days / percent",
      source: ["devis", "commercial_quote_events", "commande_client", "commande_historique", "margin_recalculations"],
      data: {
        ...quotes,
        cohorts,
        response_days_average: details?.response_days_avg ?? null,
        response_time_reliability: toNumber(details?.event_coverage_count) === toNumber(details?.eligible_count) ? "ACTUAL" : "PARTIAL",
        event_coverage: { recorded: toNumber(details?.event_coverage_count), eligible: toNumber(details?.eligible_count) },
        loss_reasons: Array.isArray(details?.loss_reasons) ? details.loss_reasons : [],
        proposed_margin: {
          gross_margin_ht: details?.margin_gross_ht ?? null,
          reliability: toNumber(details?.margin_complete_count) === toNumber(details?.eligible_count) && toNumber(details?.eligible_count) > 0
            ? "ESTIMATED" : "PARTIAL",
          complete_quotes: toNumber(details?.margin_complete_count),
          partial_quotes: toNumber(details?.margin_partial_count),
          formula: "sum(quoted revenue_ht - quoted cost_total_ht), only with complete coverage",
        },
        conversion_total_pct: conversionRate(toNumber(details?.converted_count), toNumber(details?.eligible_count)),
      },
    },
    orders: {
      definition: "Backlog restant après quantités expédiées; retard relatif à la promesse ligne.",
      unit: "currency / count / days",
      source: ["commande_client", "commande_ligne", "commande_historique", "bon_livraison_ligne"],
      data: { ...orders, aging },
    },
    receivables: {
      definition: "Solde TTC échu après paiements et avoirs alloués à la date d'arrêté.",
      unit: "currency / days",
      source: ["facture", "paiement_allocations", "avoir_source_allocations"],
      data: receivables,
    },
    exceptions,
  };
}

export async function repoOrderTimeline(commandeId: number) {
  const exists = await pool.query(`SELECT 1 FROM public.commande_client WHERE id=$1`, [commandeId]);
  if (!exists.rows[0]) return null;
  const result = await pool.query(
    `WITH events AS (
       SELECT COALESCE((to_jsonb(cc)->>'created_at')::timestamptz,cc.date_commande::timestamptz) AS occurred_at,
              'ORDER'::text AS stage,'COMMANDE'::text AS entity_type,cc.id::text AS entity_id,
              'Commande créée'::text AS label,'commande_client'::text AS source,'ACTUAL'::text AS reliability,
              jsonb_build_object('numero',cc.numero) AS details
       FROM public.commande_client cc WHERE cc.id=$1
       UNION ALL
       SELECT ch.date_action,'ANALYSIS', 'COMMANDE',ch.commande_id::text,
              'Statut '||ch.nouveau_statut,'commande_historique','ACTUAL',
              jsonb_build_object('from',ch.ancien_statut,'to',ch.nouveau_statut,'comment',ch.commentaire)
       FROM public.commande_historique ch WHERE ch.commande_id=$1
       UNION ALL
       SELECT COALESCE((to_jsonb(o)->>'created_at')::timestamptz,(to_jsonb(o)->>'updated_at')::timestamptz),
              'OF','OF',o.id::text,'OF '||COALESCE(o.numero,o.id::text),
              'ordres_fabrication','ACTUAL',jsonb_build_object('status',o.statut)
       FROM public.ordres_fabrication o WHERE o.commande_id=$1
       UNION ALL
       SELECT p.start_ts,'PRODUCTION','POINTAGE',p.id::text,
              'Pointage production '||p.time_type::text,
              'production_pointages','ACTUAL',
              jsonb_build_object('of_id',p.of_id,'status',p.status,'duration_minutes',p.duration_minutes)
       FROM public.production_pointages p
       JOIN public.ordres_fabrication o ON o.id=p.of_id
       WHERE o.commande_id=$1 AND p.status<>'CANCELLED'
       UNION ALL
       SELECT q.declared_at,'PRODUCTION','DECLARATION_QUANTITE',q.id::text,
              'Déclaration de quantité production',
              'production_quantity_declarations','ACTUAL',
              jsonb_build_object('of_id',q.of_id,'qty_good',q.qty_good,'qty_scrap',q.qty_scrap,'qty_rework',q.qty_rework)
       FROM public.production_quantity_declarations q
       JOIN public.ordres_fabrication o ON o.id=q.of_id
       WHERE o.commande_id=$1
       UNION ALL
       SELECT r.created_at,'PRODUCTION','RECEPTION_OF',r.id::text,
              'Réception de production',
              'of_receipts','ACTUAL',
              jsonb_build_object('of_id',r.of_id,'qty_ok',r.qty_ok,'qty_scrap',r.qty_scrap,'qty_rework',r.qty_rework,'quality_status',r.quality_status)
       FROM public.of_receipts r
       JOIN public.ordres_fabrication o ON o.id=r.of_id
       WHERE o.commande_id=$1
       UNION ALL
       SELECT COALESCE((to_jsonb(bl)->>'date_expedition')::date::timestamptz,bl.created_at),
              'DELIVERY','BON_LIVRAISON',bl.id::text,'Livraison '||bl.numero,
              'bon_livraison','ACTUAL',jsonb_build_object('status',bl.statut,'date_expedition',bl.date_expedition)
       FROM public.bon_livraison bl WHERE bl.commande_id=$1
       UNION ALL
       SELECT COALESCE(f.date_emission::timestamptz,f.created_at),
              'INVOICE','FACTURE',f.id::text,'Facture '||f.numero,
              'facture','ACTUAL',jsonb_build_object('status',f.statut,'total_ht',f.total_ht)
       FROM public.facture f WHERE f.commande_id=$1
     )
     SELECT * FROM events WHERE occurred_at IS NOT NULL ORDER BY occurred_at,stage,entity_id`,
    [commandeId],
  );
  const covered = new Set(result.rows.map((row) => String(row.stage)));
  return {
    commande_id: commandeId,
    generated_at: new Date().toISOString(),
    source: "live",
    reliability: "ACTUAL",
    stages: ["ORDER", "ANALYSIS", "OF", "PRODUCTION", "DELIVERY", "INVOICE"].map((stage) => ({
      stage,
      available: covered.has(stage),
    })),
    events: result.rows,
  };
}

async function inTransaction<T>(run: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRecordQuoteReminder(params: {
  devisId: number;
  input: QuoteReminderBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash({ devis_id: params.devisId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "QUOTE_REMINDER", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const quote = await loadQuoteSnapshot(tx, params.devisId, true);
    if (!quote) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
    if (quote.statut !== "ENVOYE") throw new HttpError(409, "QUOTE_NOT_SENT", "Seul un devis envoyé peut être relancé.");
    const occurredAt = params.input.occurred_at ?? new Date().toISOString();
    if (quote.date_validite && occurredAt.slice(0, 10) > quote.date_validite) {
      throw new HttpError(409, "QUOTE_EXPIRED", "Ce devis est expiré : requalifiez-le avant toute relance.");
    }
    let inserted;
    try {
      inserted = await tx.query<{ id: string; created_at: string }>(
        `INSERT INTO public.commercial_quote_events
           (devis_id,event_type,occurred_at,actor_user_id,owner_user_id,channel,note)
         VALUES ($1,'REMINDER_RECORDED',$2,$3,$4,$5,$6)
         RETURNING id::text,created_at::text`,
        [params.devisId, occurredAt, params.actor.user_id, params.input.owner_user_id ?? quote.owner_user_id,
          params.input.channel, params.input.note ?? null],
      );
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === "commercial_quote_reminder_daily_channel_uniq") {
        throw new HttpError(409, "DUPLICATE_QUOTE_REMINDER", "Une relance de ce canal est déjà enregistrée aujourd'hui.");
      }
      throw error;
    }
    const response = { event_id: inserted.rows[0]?.id, devis_id: params.devisId, idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "commercial.quote.reminder_recorded", entity_type: "devis", entity_id: String(params.devisId),
      details: { channel: params.input.channel, owner_user_id: params.input.owner_user_id ?? quote.owner_user_id },
    });
    await saveReceipt(tx, "QUOTE_REMINDER", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoRecordQuoteLoss(params: {
  devisId: number;
  input: QuoteLossBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash({ devis_id: params.devisId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "QUOTE_LOSS", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const quote = await loadQuoteSnapshot(tx, params.devisId, true);
    if (!quote) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
    if (quote.statut !== "ENVOYE") throw new HttpError(409, "QUOTE_NOT_DECIDABLE", "Seul un devis envoyé peut être déclaré perdu.");
    const occurredAt = params.input.occurred_at ?? new Date().toISOString();
    await tx.query(`UPDATE public.devis SET statut='REFUSE',updated_at=now() WHERE id=$1`, [params.devisId]);
    const event = await tx.query<{ id: string }>(
      `INSERT INTO public.commercial_quote_events
         (devis_id,event_type,occurred_at,actor_user_id,owner_user_id,reason_code,note)
       VALUES ($1,'LOST',$2,$3,$4,$5,$6) RETURNING id::text`,
      [params.devisId, occurredAt, params.actor.user_id, params.input.owner_user_id ?? quote.owner_user_id,
        params.input.reason_code, params.input.note ?? null],
    );
    const response = { event_id: event.rows[0]?.id, devis_id: params.devisId, status: "REFUSE", idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "commercial.quote.lost", entity_type: "devis", entity_id: String(params.devisId),
      details: { from: quote.statut, to: "REFUSE", reason_code: params.input.reason_code },
    });
    await saveReceipt(tx, "QUOTE_LOSS", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoRequestDiscountApproval(params: {
  devisId: number;
  input: DiscountRequestBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash({ devis_id: params.devisId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "DISCOUNT_REQUEST", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const quote = await loadQuoteSnapshot(tx, params.devisId, true);
    if (!quote) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
    if (quote.statut !== "BROUILLON") throw new HttpError(409, "QUOTE_NOT_DRAFT", "La validation porte uniquement sur un brouillon.");
    if (quote.discount_pct === null) throw new HttpError(409, "QUOTE_DISCOUNT_UNQUALIFIED", "La remise effective ne peut pas être calculée.");
    if (quote.discount_pct <= 0) throw new HttpError(409, "QUOTE_DISCOUNT_NOT_REQUIRED", "Ce devis ne contient aucune remise à valider.");
    const requestId = crypto.randomUUID();
    let event;
    try {
      event = await tx.query<{ id: string }>(
        `INSERT INTO public.commercial_quote_events
           (devis_id,event_type,occurred_at,actor_user_id,owner_user_id,note,
            quote_content_hash,discount_pct,approval_request_id)
         VALUES ($1,'DISCOUNT_REQUESTED',now(),$2,$3,$4,$5,$6,$7) RETURNING id::text`,
        [params.devisId, params.actor.user_id, quote.owner_user_id, params.input.note ?? null,
          quote.content_hash, quote.discount_pct, requestId],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "commercial_quote_discount_content_request_uniq") {
        throw new HttpError(409, "DUPLICATE_DISCOUNT_REQUEST", "Cette version du devis possède déjà une demande de validation.");
      }
      throw error;
    }
    const response = {
      event_id: event.rows[0]?.id, approval_request_id: requestId, devis_id: params.devisId,
      quote_content_hash: quote.content_hash, discount_pct: quote.discount_pct, status: "PENDING", idempotent_replay: false,
    };
    await insertAudit(tx, params.actor, {
      action: "commercial.quote.discount_requested", entity_type: "devis", entity_id: String(params.devisId),
      details: { approval_request_id: requestId, quote_content_hash: quote.content_hash, discount_pct: quote.discount_pct },
    });
    await saveReceipt(tx, "DISCOUNT_REQUEST", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoDecideDiscountApproval(params: {
  devisId: number;
  input: DiscountDecisionBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash({ devis_id: params.devisId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "DISCOUNT_DECISION", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const quote = await loadQuoteSnapshot(tx, params.devisId, true);
    if (!quote) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
    const request = await tx.query<{
      actor_user_id: number;
      quote_content_hash: string;
      discount_pct: number;
    }>(
      `SELECT actor_user_id,quote_content_hash,discount_pct::float8
       FROM public.commercial_quote_events
       WHERE devis_id=$1 AND approval_request_id=$2 AND event_type='DISCOUNT_REQUESTED'
       FOR SHARE`,
      [params.devisId, params.input.approval_request_id],
    );
    const requested = request.rows[0];
    if (!requested) throw new HttpError(404, "DISCOUNT_REQUEST_NOT_FOUND", "Demande de validation introuvable.");
    if (requested.actor_user_id === params.actor.user_id) {
      throw new HttpError(403, "DISCOUNT_SELF_APPROVAL_FORBIDDEN", "Le demandeur ne peut pas valider sa propre remise.");
    }
    if (requested.quote_content_hash !== quote.content_hash) {
      throw new HttpError(409, "QUOTE_CHANGED_AFTER_APPROVAL_REQUEST", "Le devis a changé : créez une nouvelle demande de validation.");
    }
    const eventType = params.input.decision === "APPROVE" ? "DISCOUNT_APPROVED" : "DISCOUNT_REJECTED";
    let event;
    try {
      event = await tx.query<{ id: string }>(
        `INSERT INTO public.commercial_quote_events
           (devis_id,event_type,occurred_at,actor_user_id,owner_user_id,note,
            quote_content_hash,discount_pct,approval_request_id)
         VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8) RETURNING id::text`,
        [params.devisId, eventType, params.actor.user_id, quote.owner_user_id, params.input.note,
          quote.content_hash, requested.discount_pct, params.input.approval_request_id],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "commercial_quote_discount_decision_uniq") {
        throw new HttpError(409, "DISCOUNT_ALREADY_DECIDED", "Cette demande de validation a déjà reçu une décision.");
      }
      throw error;
    }
    const response = {
      event_id: event.rows[0]?.id, approval_request_id: params.input.approval_request_id,
      devis_id: params.devisId, status: params.input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
      idempotent_replay: false,
    };
    await insertAudit(tx, params.actor, {
      action: `commercial.quote.discount_${params.input.decision.toLowerCase()}`,
      entity_type: "devis", entity_id: String(params.devisId),
      details: { approval_request_id: params.input.approval_request_id, quote_content_hash: quote.content_hash },
    });
    await saveReceipt(tx, "DISCOUNT_DECISION", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoExpireDueQuotes(params: {
  input: ExpireDueQuotesBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash(params.input);
    const replay = await readReceipt<Record<string, unknown>>(tx, "EXPIRE_DUE_QUOTES", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const due = await tx.query<{ id: string; numero: string; owner_user_id: number | null }>(
      `SELECT id::text,numero,user_id AS owner_user_id FROM public.devis
       WHERE statut='ENVOYE' AND date_validite<$1::date
       ORDER BY date_validite,id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [params.input.as_of, params.input.limit],
    );
    const ids = due.rows.map((row) => Number(row.id));
    if (ids.length > 0) {
      await tx.query(`UPDATE public.devis SET statut='EXPIRE',updated_at=now() WHERE id=ANY($1::bigint[])`, [ids]);
      for (const quote of due.rows) {
        await tx.query(
          `INSERT INTO public.commercial_quote_events
             (devis_id,event_type,occurred_at,actor_user_id,owner_user_id)
           VALUES ($1,'EXPIRED',$2::date::timestamptz,$3,$4)`,
          [quote.id, params.input.as_of, params.actor.user_id, quote.owner_user_id],
        );
      }
    }
    const response = { as_of: params.input.as_of, expired_count: ids.length, devis_ids: ids, idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "commercial.quote.expire_due", entity_type: "devis_batch", entity_id: params.input.as_of,
      details: { expired_count: ids.length, devis_ids: ids },
    });
    await saveReceipt(tx, "EXPIRE_DUE_QUOTES", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoCancelOrder(params: {
  commandeId: number;
  input: CancelOrderBodyDTO;
  actor: CommercialActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    const requestHash = commercialPayloadHash({ commande_id: params.commandeId, ...params.input });
    const replay = await readReceipt<Record<string, unknown>>(tx, "ORDER_CANCEL", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const order = await tx.query<{ id: string; numero: string }>(
      `SELECT id::text,numero FROM public.commande_client WHERE id=$1 FOR UPDATE`,
      [params.commandeId],
    );
    if (!order.rows[0]) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable.");
    const last = await tx.query<{ nouveau_statut: string }>(
      `SELECT nouveau_statut FROM public.commande_historique WHERE commande_id=$1
       ORDER BY date_action DESC,id DESC LIMIT 1 FOR UPDATE`,
      [params.commandeId],
    );
    const current = normalizeCommandeWorkflowStatus(last.rows[0]?.nouveau_statut ?? "BROUILLON");
    if (!current) throw new HttpError(409, "COMMAND_STATUS_HISTORY_INVALID", "Le statut courant est inconnu.");
    if (["LIVRE", "FACTURE", "ARCHIVE", "ANNULE"].includes(current)) {
      throw new HttpError(409, "ORDER_CANCELLATION_TOO_LATE", "Une commande livrée, facturée, archivée ou déjà annulée ne peut pas être annulée ici.");
    }
    const downstream = await tx.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.bon_livraison WHERE commande_id=$1 AND statut IN ('SHIPPED','DELIVERED')
       ) OR EXISTS (
         SELECT 1 FROM public.facture WHERE commande_id=$1 AND statut NOT IN ('DRAFT','CANCELLED','brouillon','annule','annulee')
       ) AS blocked`,
      [params.commandeId],
    );
    if (downstream.rows[0]?.blocked) {
      throw new HttpError(409, "ORDER_CANCELLATION_HAS_DOWNSTREAM_EVIDENCE", "Annulation refusée : livraison ou facture active déjà enregistrée.");
    }
    await tx.query(
      `INSERT INTO public.commercial_order_cancellations
         (commande_id,reason_code,note,cancelled_by)
       VALUES ($1,$2,$3,$4)`,
      [params.commandeId, params.input.reason_code, params.input.note ?? null, params.actor.user_id],
    );
    await tx.query(
      `INSERT INTO public.commande_historique
         (commande_id,user_id,ancien_statut,nouveau_statut,commentaire)
       VALUES ($1,$2,$3,'ANNULE',$4)`,
      [params.commandeId, params.actor.user_id, current, `SOL-17:${params.input.reason_code}`],
    );
    await tx.query(
      `INSERT INTO public.commande_client_event_log
         (commande_id,event_type,old_values,new_values,user_id)
       VALUES ($1,'ORDER_CANCELLED',$2::jsonb,$3::jsonb,$4)`,
      [params.commandeId, JSON.stringify({ statut: current }), JSON.stringify({ statut: "ANNULE", reason_code: params.input.reason_code }), params.actor.user_id],
    );
    const response = { commande_id: params.commandeId, status: "ANNULE", idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "commercial.order.cancel", entity_type: "commande_client", entity_id: String(params.commandeId),
      details: { from: current, to: "ANNULE", reason_code: params.input.reason_code },
    });
    await saveReceipt(tx, "ORDER_CANCEL", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}
