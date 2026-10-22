import type { PoolClient } from "pg";
import { HttpError } from "../../../../utils/httpError";
import type { CutoverRow } from "../../types/data-cutover.types";
import type { CutoverTarget } from "./openings.contract";

type OpeningKind = "WIP" | "FINANCE_BALANCE" | "UNBILLED_LEGACY_DOCUMENT";
type StoredOpening = { id: string; opening_kind: OpeningKind; domain: string; created_at: string };

async function assertRowCurrentTx(client: PoolClient, row: CutoverRow) {
  const found = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.data_cutover_rows
     WHERE id=$1::uuid AND batch_id=$2::uuid AND domain=$3 AND decision='INCLUDE' FOR KEY SHARE`,
    [row.id, row.batch_id, row.domain]
  );
  if (!found.rows[0]) throw new HttpError(409, "CUTOVER_OPENING_ROW_CHANGED", "Cette fiche de reprise a changé ; actualisez-la avant son application.");
}

async function insertOpeningStateTx(client: PoolClient, input: {
  row: CutoverRow; kind: OpeningKind; actorId: number; state: Record<string, unknown>;
}): Promise<{ id: string; reference: string }> {
  await assertRowCurrentTx(client, input.row);
  const provenance = {
    source_id: input.row.source_id, sheet: input.row.sheet, row_number: input.row.row_number,
    legacy_key: input.row.legacy_key, source_issues: input.row.source_issues, source_notes: input.row.source_notes ?? [],
  };
  const existing = await client.query<StoredOpening>(
    `SELECT id::text AS id,opening_kind,domain,created_at::text AS created_at
     FROM public.data_cutover_opening_states WHERE row_id=$1::uuid AND opening_kind=$2 FOR KEY SHARE`,
    [input.row.id, input.kind]
  );
  const stored = existing.rows[0] ?? (await client.query<StoredOpening>(
    `INSERT INTO public.data_cutover_opening_states(batch_id,row_id,opening_kind,domain,source_system,state,provenance,created_by)
     VALUES($1::uuid,$2::uuid,$3,$4,'CLIPPER_EXCEL',$5::jsonb,$6::jsonb,$7)
     ON CONFLICT(row_id,opening_kind) DO NOTHING
     RETURNING id::text AS id,opening_kind,domain,created_at::text AS created_at`,
    [input.row.batch_id, input.row.id, input.kind, input.row.domain, JSON.stringify(input.state), JSON.stringify(provenance), input.actorId]
  )).rows[0];
  if (!stored) {
    const replay = await client.query<StoredOpening>(`SELECT id::text AS id,opening_kind,domain,created_at::text AS created_at FROM public.data_cutover_opening_states WHERE row_id=$1::uuid AND opening_kind=$2 FOR KEY SHARE`, [input.row.id, input.kind]);
    if (!replay.rows[0]) throw new Error("CUTOVER_OPENING_STATE_NOT_STORED");
    return { id: replay.rows[0].id, reference: `OPEN-${input.kind}-${replay.rows[0].id}` };
  }
  return { id: stored.id, reference: `OPEN-${input.kind}-${stored.id}` };
}

export async function createWipOpeningStateTx(client: PoolClient, input: { row: CutoverRow; article: CutoverTarget; affair: CutoverTarget; actorId: number }) {
  return insertOpeningStateTx(client, { row: input.row, kind: "WIP", actorId: input.actorId, state: {
    status: "OPENING_REVIEW_REQUIRED", article: input.article, affair: input.affair,
    quantity_remaining: input.row.values.quantityRemaining, quantity_completed: input.row.values.quantityCompleted,
    scrap_quantity: input.row.values.scrapQuantity, current_phase: input.row.values.currentPhase,
    phase_state: input.row.values.phaseState, technical_revision: input.row.values.technicalRevision,
    workshop_validator: input.row.values.workshopValidator, evidence: input.row.values.evidenceReference,
    subcontract_reference: input.row.values.subcontractReference ?? null,
    historical_timesheets_created: false, native_of_created: false,
  } });
}

export async function createFinanceOpeningBalanceTx(client: PoolClient, input: { row: CutoverRow; partner: CutoverTarget; actorId: number }) {
  return insertOpeningStateTx(client, { row: input.row, kind: "FINANCE_BALANCE", actorId: input.actorId, state: {
    status: "OPENING_REVIEW_REQUIRED", partner: input.partner, document_number: input.row.values.documentNumber,
    document_kind: input.row.values.documentKind, document_date: input.row.values.documentDate, due_date: input.row.values.dueDate,
    currency: input.row.values.currency, original_amount: input.row.values.originalAmount,
    payments_allocated: input.row.values.paymentsAllocated, credits_allocated: input.row.values.creditsAllocated,
    deposits_allocated: input.row.values.depositsAllocated, open_balance: input.row.values.openBalance,
    accounting_evidence: input.row.values.accountingEvidence, document_evidence: input.row.values.documentEvidence,
    fiscal_document_created: false, payment_created: false,
  } });
}

export async function createUnbilledLegacyDocumentStateTx(client: PoolClient, input: { row: CutoverRow; partner: CutoverTarget; article: CutoverTarget; actorId: number }) {
  return insertOpeningStateTx(client, { row: input.row, kind: "UNBILLED_LEGACY_DOCUMENT", actorId: input.actorId, state: {
    status: "OPENING_REVIEW_REQUIRED", partner: input.partner, article: input.article,
    document_number: input.row.domain === "LEGACY_DELIVERY" ? input.row.values.deliveryNumber : input.row.values.receiptNumber,
    source_order_number: input.row.domain === "LEGACY_DELIVERY" ? input.row.values.customerOrderNumber : input.row.values.supplierOrderNumber,
    quantity: input.row.values.quantity, unit: input.row.values.unit,
    occurred_on: input.row.domain === "LEGACY_DELIVERY" ? input.row.values.deliveryDate : input.row.values.receiptDate,
    billing_status: input.row.values.billingStatus, unbilled_amount: input.row.values.unbilledAmount,
    evidence: input.row.values.evidenceReference, stock_movement_created: false, fiscal_document_created: false,
  } });
}

export async function listCutoverOpeningStatesTx(client: Pick<PoolClient, "query">, batchId: string) {
  const result = await client.query<{
    id: string; row_id: string; opening_kind: OpeningKind; domain: string; state: Record<string, unknown>;
    provenance: Record<string, unknown>; created_at: string; links: Array<{ link_kind: string; native_target_type: string; native_target_id: string; native_target_reference: string; evidence_reference: string; created_at: string }>;
  }>(
    `SELECT state.id::text AS id,state.row_id::text AS row_id,state.opening_kind,state.domain,state.state,state.provenance,state.created_at::text,
      COALESCE(jsonb_agg(jsonb_build_object('link_kind',link.link_kind,'native_target_type',link.native_target_type,'native_target_id',link.native_target_id,'native_target_reference',link.native_target_reference,'evidence_reference',link.evidence_reference,'created_at',link.created_at::text) ORDER BY link.created_at,link.id) FILTER (WHERE link.id IS NOT NULL),'[]'::jsonb) AS links
     FROM public.data_cutover_opening_states state LEFT JOIN public.data_cutover_opening_links link ON link.opening_state_id=state.id
     WHERE state.batch_id=$1::uuid GROUP BY state.id ORDER BY state.opening_kind,state.created_at,state.id`, [batchId]
  );
  return result.rows.map((row) => ({ ...row, status: row.links.some((link) => link.link_kind === "NATIVE_TARGET") ? "ATTACHED" as const : "OPENING_REVIEW_REQUIRED" as const }));
}
