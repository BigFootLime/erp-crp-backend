import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import {
  assertPreviewCanAdvance,
  buildAccountingPreview,
  GenericDelimitedV1Adapter,
  type AccountingMappingConfig,
  type AccountingEntryLine,
  type AccountingPreview,
  type AccountingSourceDocument,
  type AccountingSourceType,
} from "./accounting-export.domain";
import { accountingMappingConfigSchema, type CancelAccountingBatchDTO, type CreateAccountingMappingDTO, type CreateAccountingPreviewDTO, type ExpectedBatchVersionDTO, type ReexportAccountingBatchDTO } from "./accounting-export.validators";
import { financeRequestHash, normalizeIdempotencyKey } from "../facturation/domain/finance-policy";
import { insertGlobalFinanceAudit, newCorrelationId, type FinanceActorContext } from "../facturation/repository/workflow.repository.shared";

type MappingRow = {
  id: string;
  version_code: string;
  adapter_code: "GENERIC_DELIMITED_V1";
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  effective_from: string;
  effective_to: string | null;
  config: AccountingMappingConfig;
  config_sha256: string;
  created_at: string;
  activated_at: string | null;
};

type BatchRow = {
  id: string;
  batch_number: string;
  mapping_version_id: string;
  mapping_version_code: string;
  adapter_code: string;
  period_from: string;
  period_to: string;
  source_types: AccountingSourceType[];
  status: "PREVIEWED" | "VALIDATED" | "GENERATED" | "CANCELLED";
  row_version: number;
  source_count: number;
  line_count: number;
  currency_totals: AccountingPreview["currency_totals"];
  findings: AccountingPreview["findings"];
  source_sha256: string;
  lines_sha256: string;
  artifact_filename: string | null;
  artifact_sha256: string | null;
  artifact_size: number | null;
  created_at: string;
  validated_at: string | null;
  generated_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  reexport_of_batch_id: string | null;
  correlation_id: string;
};

function mappingFromRow(row: MappingRow): MappingRow {
  return { ...row, config: accountingMappingConfigSchema.parse(row.config) };
}

async function acquireReceipt(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  idempotencyKeyRaw: string | undefined;
  commandType: string;
  payload: unknown;
}): Promise<{ key: string; hash: string; replay: Record<string, unknown> | null }> {
  const key = normalizeIdempotencyKey(params.idempotencyKeyRaw);
  const hash = financeRequestHash(params.commandType, params.payload);
  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accounting-export:${params.actor.userId}:${key}`]);
  const existing = await params.client.query<{ request_hash: string; result_payload: Record<string, unknown> }>(
    `SELECT request_hash, result_payload FROM public.accounting_export_command_receipts WHERE actor_user_id = $1 AND idempotency_key = $2`,
    [params.actor.userId, key]
  );
  const receipt = existing.rows[0];
  if (receipt && receipt.request_hash !== hash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.");
  }
  return { key, hash, replay: receipt?.result_payload ?? null };
}

async function saveReceipt(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  key: string;
  hash: string;
  commandType: string;
  aggregateId: string;
  result: unknown;
}): Promise<void> {
  await params.client.query(
    `INSERT INTO public.accounting_export_command_receipts
      (actor_user_id,idempotency_key,request_hash,command_type,aggregate_id,result_payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [params.actor.userId, params.key, params.hash, params.commandType, params.aggregateId, JSON.stringify(params.result)]
  );
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function mappingById(client: PoolClient, id: string, lock = false): Promise<MappingRow> {
  const result = await client.query<MappingRow>(
    `SELECT id::text,version_code,adapter_code,status,effective_from::text,effective_to::text,
            config,config_sha256,created_at::text,activated_at::text
     FROM public.accounting_export_mapping_versions WHERE id=$1::uuid ${lock ? "FOR SHARE" : ""}`,
    [id]
  );
  if (!result.rows[0]) throw new HttpError(404, "ACCOUNTING_MAPPING_NOT_FOUND", "Version de mapping introuvable.");
  return mappingFromRow(result.rows[0]);
}

async function batchById(client: PoolClient, id: string, lock = false): Promise<BatchRow> {
  const result = await client.query<BatchRow>(
    `SELECT b.id::text,b.batch_number,b.mapping_version_id::text,m.version_code AS mapping_version_code,
            m.adapter_code,b.period_from::text,b.period_to::text,b.source_types,b.status,b.row_version,
            b.source_count,b.line_count,b.currency_totals,b.findings,b.source_sha256,b.lines_sha256,
            b.artifact_filename,b.artifact_sha256,b.artifact_size,b.created_at::text,b.validated_at::text,
            b.generated_at::text,b.cancelled_at::text,b.cancellation_reason,b.reexport_of_batch_id::text,
            b.correlation_id::text
     FROM public.accounting_export_batches b
     JOIN public.accounting_export_mapping_versions m ON m.id=b.mapping_version_id
     WHERE b.id=$1::uuid ${lock ? "FOR UPDATE OF b" : ""}`,
    [id]
  );
  if (!result.rows[0]) throw new HttpError(404, "ACCOUNTING_EXPORT_NOT_FOUND", "Lot comptable introuvable.");
  return result.rows[0];
}

const UPDATED_AT_SQL = `to_char(source.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function loadSources(client: PoolClient, input: CreateAccountingPreviewDTO): Promise<AccountingSourceDocument[]> {
  const rows: AccountingSourceDocument[] = [];
  if (input.source_types.includes("INVOICE")) {
    const result = await client.query<AccountingSourceDocument>(
      `SELECT 'INVOICE'::text AS source_type, source.id::text AS source_id,
              COALESCE(source.legal_number,source.numero) AS source_number,
              ${UPDATED_AT_SQL} AS source_updated_at,source.date_emission::text AS entry_date,
              source.client_id,NULLIF(btrim(client.compte_tiers),'') AS third_party_account,
              upper(source.currency) AS currency,NULL::text AS payment_mode,
              source.total_ht::numeric(18,2)::text AS total_ex_tax,
              COALESCE(source.total_tax,source.total_ttc-source.total_ht)::numeric(18,2)::text AS total_tax,
              source.total_ttc::numeric(18,2)::text AS total_incl_tax,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('tax_rate',tax.tax_rate,'total_ex_tax',tax.total_ex_tax,'tax_amount',tax.tax_amount) ORDER BY tax.tax_rate)
                FROM (SELECT fl.taux_tva::numeric(8,4)::text AS tax_rate,
                             SUM(fl.total_ht)::numeric(18,2)::text AS total_ex_tax,
                             SUM(COALESCE(fl.tax_amount,fl.total_ttc-fl.total_ht))::numeric(18,2)::text AS tax_amount
                      FROM public.facture_ligne fl WHERE fl.facture_id=source.id GROUP BY fl.taux_tva) tax),'[]'::jsonb) AS tax_breakdown,
              claim.batch_id::text AS claimed_batch_id
       FROM public.facture source JOIN public.clients client ON client.client_id=source.client_id
       LEFT JOIN public.accounting_export_source_claims claim ON claim.source_type='INVOICE' AND claim.source_id=source.id::text AND claim.released_at IS NULL
       WHERE source.document_status='ISSUED' AND source.date_emission BETWEEN $1::date AND $2::date
       ORDER BY source.date_emission,source.id`,
      [input.period_from, input.period_to]
    );
    rows.push(...result.rows);
  }
  if (input.source_types.includes("CREDIT_NOTE")) {
    const result = await client.query<AccountingSourceDocument>(
      `SELECT 'CREDIT_NOTE'::text AS source_type,source.id::text AS source_id,
              COALESCE(source.legal_number,source.numero) AS source_number,
              ${UPDATED_AT_SQL} AS source_updated_at,source.date_emission::text AS entry_date,
              source.client_id,NULLIF(btrim(client.compte_tiers),'') AS third_party_account,
              upper(source.currency) AS currency,NULL::text AS payment_mode,
              source.total_ht::numeric(18,2)::text AS total_ex_tax,
              COALESCE(source.total_tax,source.total_ttc-source.total_ht)::numeric(18,2)::text AS total_tax,
              source.total_ttc::numeric(18,2)::text AS total_incl_tax,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('tax_rate',tax.tax_rate,'total_ex_tax',tax.total_ex_tax,'tax_amount',tax.tax_amount) ORDER BY tax.tax_rate)
                FROM (SELECT al.taux_tva::numeric(8,4)::text AS tax_rate,
                             SUM(al.total_ht)::numeric(18,2)::text AS total_ex_tax,
                             SUM(COALESCE(al.tax_amount,al.total_ttc-al.total_ht))::numeric(18,2)::text AS tax_amount
                      FROM public.avoir_ligne al WHERE al.avoir_id=source.id GROUP BY al.taux_tva) tax),'[]'::jsonb) AS tax_breakdown,
              claim.batch_id::text AS claimed_batch_id
       FROM public.avoir source JOIN public.clients client ON client.client_id=source.client_id
       LEFT JOIN public.accounting_export_source_claims claim ON claim.source_type='CREDIT_NOTE' AND claim.source_id=source.id::text AND claim.released_at IS NULL
       WHERE source.statut IN ('ISSUED','emis','emise','envoyee') AND source.date_emission BETWEEN $1::date AND $2::date
       ORDER BY source.date_emission,source.id`,
      [input.period_from, input.period_to]
    );
    rows.push(...result.rows);
  }
  if (input.source_types.includes("PAYMENT")) {
    const result = await client.query<AccountingSourceDocument>(
      `SELECT 'PAYMENT'::text AS source_type,source.id::text AS source_id,
              COALESCE(source.code,'PAY-'||source.id::text) AS source_number,
              ${UPDATED_AT_SQL} AS source_updated_at,COALESCE(source.booking_date,source.date_paiement)::text AS entry_date,
              source.client_id,NULLIF(btrim(client.compte_tiers),'') AS third_party_account,
              upper(source.currency) AS currency,NULLIF(btrim(source.mode),'') AS payment_mode,
              '0.00'::text AS total_ex_tax,'0.00'::text AS total_tax,
              source.montant::numeric(18,2)::text AS total_incl_tax,'[]'::jsonb AS tax_breakdown,
              claim.batch_id::text AS claimed_batch_id
       FROM public.paiement source JOIN public.clients client ON client.client_id=source.client_id
       LEFT JOIN public.accounting_export_source_claims claim ON claim.source_type='PAYMENT' AND claim.source_id=source.id::text AND claim.released_at IS NULL
       WHERE source.status NOT IN ('REJECTED','REVERSED') AND source.workflow_status<>'REVERSED'
         AND COALESCE(source.booking_date,source.date_paiement) BETWEEN $1::date AND $2::date
       ORDER BY COALESCE(source.booking_date,source.date_paiement),source.id`,
      [input.period_from, input.period_to]
    );
    rows.push(...result.rows);
  }
  for (const sourceType of ["SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE"] as const) {
    if (!input.source_types.includes(sourceType)) continue;
    const documentType = sourceType === "SUPPLIER_INVOICE" ? "INVOICE" : "CREDIT_NOTE";
    const result = await client.query<AccountingSourceDocument>(
      `SELECT $3::text AS source_type,source.id::text AS source_id,
              source.legal_number AS source_number,
              ${UPDATED_AT_SQL} AS source_updated_at,source.issue_date::text AS entry_date,
              source.fournisseur_id::text AS client_id,NULLIF(btrim(supplier.compte_tiers),'') AS third_party_account,
              upper(source.currency) AS currency,NULL::text AS payment_mode,
              source.total_without_vat::numeric(18,2)::text AS total_ex_tax,
              source.total_vat::numeric(18,2)::text AS total_tax,
              source.total_with_vat::numeric(18,2)::text AS total_incl_tax,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'tax_category',item->>'category',
                  'tax_rate',item->>'rate',
                  'total_ex_tax',item->>'taxable_amount',
                  'tax_amount',item->>'tax_amount'
                ) ORDER BY item->>'category',item->>'rate')
                FROM jsonb_array_elements(source.vat_breakdown) item
              ),'[]'::jsonb) AS tax_breakdown,
              upper(COALESCE(
                source.seller_snapshot #>> '{postal_address,country_code}',
                source.seller_snapshot #>> '{postal_address,country}'
              )) AS partner_country_code,
              claim.batch_id::text AS claimed_batch_id
       FROM public.supplier_invoices source
       JOIN public.fournisseurs supplier ON supplier.id=source.fournisseur_id
       LEFT JOIN public.accounting_export_source_claims claim
         ON claim.source_type=$3 AND claim.source_id=source.id::text AND claim.released_at IS NULL
       WHERE source.document_type=$4
         AND source.status IN ('APPROVED','ACCOUNTING_EXPORTED','CLOSED')
         AND source.issue_date BETWEEN $1::date AND $2::date
       ORDER BY source.issue_date,source.id`,
      [input.period_from, input.period_to, sourceType, documentType]
    );
    rows.push(...result.rows);
  }
  return rows;
}

async function persistPreview(params: {
  client: PoolClient;
  input: CreateAccountingPreviewDTO;
  actor: FinanceActorContext;
  mapping: MappingRow;
  reexportOf?: string | null;
}): Promise<BatchRow> {
  if (params.mapping.status !== "ACTIVE") throw new HttpError(409, "ACCOUNTING_MAPPING_NOT_ACTIVE", "Le mapping doit être actif.");
  if (params.mapping.effective_from > params.input.period_from || (params.mapping.effective_to && params.mapping.effective_to < params.input.period_to)) {
    throw new HttpError(422, "ACCOUNTING_MAPPING_PERIOD_MISMATCH", "La version de mapping ne couvre pas toute la période demandée.");
  }
  const sources = await loadSources(params.client, params.input);
  const preview = buildAccountingPreview(sources, params.mapping.config);
  const correlationId = newCorrelationId();
  const id = crypto.randomUUID();
  const batchNumber = `ACCT-${params.input.period_to.replace(/-/g, "")}-${id.slice(0, 8).toUpperCase()}`;
  await params.client.query(
    `INSERT INTO public.accounting_export_batches
      (id,batch_number,mapping_version_id,period_from,period_to,source_types,status,row_version,
       source_count,line_count,currency_totals,findings,source_sha256,lines_sha256,created_by,correlation_id,reexport_of_batch_id)
     VALUES ($1::uuid,$2,$3::uuid,$4::date,$5::date,$6::text[],'PREVIEWED',1,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14::uuid,$15::uuid)`,
    [id,batchNumber,params.mapping.id,params.input.period_from,params.input.period_to,params.input.source_types,
      preview.source_count,preview.lines.length,JSON.stringify(preview.currency_totals),JSON.stringify(preview.findings),
      preview.source_sha256,preview.lines_sha256,params.actor.userId,correlationId,params.reexportOf ?? null]
  );
  for (const source of sources) {
    await params.client.query(
      `INSERT INTO public.accounting_export_batch_sources
        (batch_id,source_type,source_id,source_number,source_updated_at,source_snapshot)
       VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6::jsonb)`,
      [id,source.source_type,source.source_id,source.source_number,source.source_updated_at,JSON.stringify(source)]
    );
  }
  for (const line of preview.lines) {
    await params.client.query(
      `INSERT INTO public.accounting_export_entries
        (batch_id,line_no,source_type,source_id,source_number,source_updated_at,entry_date,journal_code,
         account_number,third_party_account,label,piece_reference,currency,debit,credit,tax_rate,axes)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [id,line.line_no,line.source_type,line.source_id,line.source_number,line.source_updated_at,line.entry_date,line.journal_code,
        line.account_number,line.third_party_account,line.label,line.piece_reference,line.currency,line.debit,line.credit,line.tax_rate,JSON.stringify(line.axes)]
    );
  }
  await insertGlobalFinanceAudit({ client: params.client, actor: params.actor, action: "accounting_export.previewed", entityType: "accounting_export_batch", entityId: id, details: { batch_number: batchNumber, mapping_version: params.mapping.version_code, period_from: params.input.period_from, period_to: params.input.period_to, source_count: preview.source_count, line_count: preview.lines.length, blocker_count: preview.findings.filter((item) => item.severity === "BLOCKER").length, correlation_id: correlationId } });
  return batchById(params.client, id);
}

export async function repoListAccountingMappings(includeRetired: boolean): Promise<MappingRow[]> {
  const result = await pool.query<MappingRow>(
    `SELECT id::text,version_code,adapter_code,status,effective_from::text,effective_to::text,config,config_sha256,created_at::text,activated_at::text
     FROM public.accounting_export_mapping_versions WHERE ($1::boolean OR status<>'RETIRED') ORDER BY effective_from DESC,created_at DESC`,
    [includeRetired]
  );
  return result.rows.map(mappingFromRow);
}

export async function repoCreateAccountingMapping(params: { input: CreateAccountingMappingDTO; actor: FinanceActorContext; idempotencyKey?: string }): Promise<MappingRow & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireReceipt({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: "ACCOUNTING_MAPPING_CREATE", payload: params.input });
    if (receipt.replay) { await client.query("COMMIT"); return { ...(receipt.replay as unknown as MappingRow), idempotent_replay: true }; }
    if (params.input.activate) {
      const overlap = await client.query(`SELECT id FROM public.accounting_export_mapping_versions WHERE status='ACTIVE' AND effective_from<=COALESCE($1::date,'infinity'::date) AND COALESCE(effective_to,'infinity'::date)>=$2::date FOR UPDATE`, [params.input.effective_to ?? null, params.input.effective_from]);
      if (overlap.rows[0]) throw new HttpError(409, "ACCOUNTING_MAPPING_PERIOD_OVERLAP", "Un mapping actif couvre déjà cette période.");
    }
    const id = crypto.randomUUID();
    const configSha = financeRequestHash("ACCOUNTING_MAPPING_CONFIG", params.input.config);
    const inserted = await client.query<MappingRow>(
      `INSERT INTO public.accounting_export_mapping_versions
        (id,version_code,adapter_code,status,effective_from,effective_to,config,config_sha256,created_by,activated_at,activated_by)
       VALUES ($1::uuid,$2,$3,$4,$5::date,$6::date,$7::jsonb,$8,$9::integer,CASE WHEN $10::boolean THEN now() END,CASE WHEN $10::boolean THEN $9::integer END)
       RETURNING id::text,version_code,adapter_code,status,effective_from::text,effective_to::text,config,config_sha256,created_at::text,activated_at::text`,
      [id,params.input.version_code,params.input.adapter_code,params.input.activate ? "ACTIVE" : "DRAFT",params.input.effective_from,params.input.effective_to ?? null,JSON.stringify(params.input.config),configSha,params.actor.userId,params.input.activate]
    );
    const result = { ...mappingFromRow(inserted.rows[0]!), idempotent_replay: false };
    await insertGlobalFinanceAudit({ client, actor: params.actor, action: "accounting_export.mapping_created", entityType: "accounting_export_mapping", entityId: id, details: { version_code: params.input.version_code, adapter_code: params.input.adapter_code, status: result.status, effective_from: result.effective_from, effective_to: result.effective_to, config_sha256: configSha } });
    await saveReceipt({ client, actor: params.actor, key: receipt.key, hash: receipt.hash, commandType: "ACCOUNTING_MAPPING_CREATE", aggregateId: id, result });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function repoCreateAccountingPreview(params: { input: CreateAccountingPreviewDTO; actor: FinanceActorContext; idempotencyKey?: string }): Promise<BatchRow & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireReceipt({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: "ACCOUNTING_EXPORT_PREVIEW", payload: params.input });
    if (receipt.replay) { await client.query("COMMIT"); return { ...(receipt.replay as unknown as BatchRow), idempotent_replay: true }; }
    const mapping = await mappingById(client, params.input.mapping_version_id, true);
    const batch = await persistPreview({ client, input: params.input, actor: params.actor, mapping });
    const result = { ...batch, idempotent_replay: false };
    await saveReceipt({ client, actor: params.actor, key: receipt.key, hash: receipt.hash, commandType: "ACCOUNTING_EXPORT_PREVIEW", aggregateId: batch.id, result });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

async function entryLines(client: PoolClient, batchId: string) {
  const result = await client.query(
    `SELECT line_no,source_type,source_id,source_number,to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_updated_at,
            entry_date::text,journal_code,account_number,third_party_account,label,piece_reference,currency,
            debit::numeric(18,2)::text,credit::numeric(18,2)::text,tax_rate::text,axes
     FROM public.accounting_export_entries WHERE batch_id=$1::uuid ORDER BY line_no`,
    [batchId]
  );
  return result.rows;
}

async function runBatchCommand(params: {
  batchId: string;
  body: ExpectedBatchVersionDTO;
  actor: FinanceActorContext;
  idempotencyKey?: string;
  commandType: "ACCOUNTING_EXPORT_VALIDATE" | "ACCOUNTING_EXPORT_GENERATE";
}): Promise<BatchRow & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireReceipt({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: params.commandType, payload: { batch_id: params.batchId, ...params.body } });
    if (receipt.replay) { await client.query("COMMIT"); return { ...(receipt.replay as unknown as BatchRow), idempotent_replay: true }; }
    const batch = await batchById(client, params.batchId, true);
    if (batch.row_version !== params.body.expected_version) throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le lot comptable a changé.");
    const expectedStatus = params.commandType === "ACCOUNTING_EXPORT_VALIDATE" ? "PREVIEWED" : "VALIDATED";
    if (batch.status !== expectedStatus) throw new HttpError(409, "ACCOUNTING_EXPORT_TRANSITION_FORBIDDEN", `Le lot doit être ${expectedStatus}.`);
    const mapping = await mappingById(client, batch.mapping_version_id, true);
    const freshPreview = buildAccountingPreview(
      await loadSources(client, {
        mapping_version_id: batch.mapping_version_id,
        period_from: batch.period_from,
        period_to: batch.period_to,
        source_types: batch.source_types,
      }),
      mapping.config
    );
    if (freshPreview.source_sha256 !== batch.source_sha256 || freshPreview.lines_sha256 !== batch.lines_sha256) {
      throw new HttpError(409, "ACCOUNTING_EXPORT_PREVIEW_STALE", "Les pièces comptables ont changé depuis l'aperçu; créez un nouvel aperçu.");
    }
    assertPreviewCanAdvance(freshPreview);
    const lines = await entryLines(client, batch.id) as AccountingEntryLine[];
    let artifact: Buffer | null = null;
    if (params.commandType === "ACCOUNTING_EXPORT_GENERATE") {
      for (const source of await client.query<{ source_type: AccountingSourceType; source_id: string }>(`SELECT source_type,source_id FROM public.accounting_export_batch_sources WHERE batch_id=$1::uuid ORDER BY source_type,source_id`, [batch.id]).then((result) => result.rows)) {
        try {
          await client.query(`INSERT INTO public.accounting_export_source_claims(batch_id,source_type,source_id,claimed_by) VALUES ($1::uuid,$2,$3,$4)`, [batch.id,source.source_type,source.source_id,params.actor.userId]);
        } catch (error) {
          if ((error as { code?: string }).code === "23505") throw new HttpError(409, "ACCOUNTING_SOURCE_ALREADY_EXPORTED", "Une pièce du lot a déjà été exportée par un autre lot.");
          throw error;
        }
        if (source.source_type === "SUPPLIER_INVOICE" || source.source_type === "SUPPLIER_CREDIT_NOTE") {
          await client.query(
            `UPDATE public.supplier_invoices
                SET status='ACCOUNTING_EXPORTED',accounting_exported_at=COALESCE(accounting_exported_at,now()),
                    row_version=row_version+1,updated_at=now()
              WHERE id=$1::uuid AND status='APPROVED'`,
            [source.source_id]
          );
        }
      }
      artifact = new GenericDelimitedV1Adapter().render(lines, mapping.config);
      const filename = `${batch.batch_number}.csv`;
      await client.query(`UPDATE public.accounting_export_batches SET status='GENERATED',row_version=row_version+1,generated_at=now(),generated_by=$2,artifact_filename=$3,artifact_sha256=$4,artifact_size=$5,artifact_content=$6 WHERE id=$1::uuid`, [batch.id,params.actor.userId,filename,sha256Buffer(artifact),artifact.length,artifact]);
    } else {
      await client.query(`UPDATE public.accounting_export_batches SET status='VALIDATED',row_version=row_version+1,validated_at=now(),validated_by=$2 WHERE id=$1::uuid`, [batch.id,params.actor.userId]);
    }
    const result = { ...(await batchById(client, batch.id)), idempotent_replay: false };
    await insertGlobalFinanceAudit({ client, actor: params.actor, action: params.commandType === "ACCOUNTING_EXPORT_GENERATE" ? "accounting_export.generated" : "accounting_export.validated", entityType: "accounting_export_batch", entityId: batch.id, details: { batch_number: batch.batch_number, line_count: batch.line_count, source_count: batch.source_count, artifact_sha256: result.artifact_sha256, correlation_id: batch.correlation_id } });
    await saveReceipt({ client, actor: params.actor, key: receipt.key, hash: receipt.hash, commandType: params.commandType, aggregateId: batch.id, result });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export const repoValidateAccountingBatch = (params: Omit<Parameters<typeof runBatchCommand>[0], "commandType">) => runBatchCommand({ ...params, commandType: "ACCOUNTING_EXPORT_VALIDATE" });
export const repoGenerateAccountingBatch = (params: Omit<Parameters<typeof runBatchCommand>[0], "commandType">) => runBatchCommand({ ...params, commandType: "ACCOUNTING_EXPORT_GENERATE" });

export async function repoCancelAccountingBatch(params: { batchId: string; body: CancelAccountingBatchDTO; actor: FinanceActorContext; idempotencyKey?: string }): Promise<BatchRow & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireReceipt({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: "ACCOUNTING_EXPORT_CANCEL", payload: { batch_id: params.batchId, ...params.body } });
    if (receipt.replay) { await client.query("COMMIT"); return { ...(receipt.replay as unknown as BatchRow), idempotent_replay: true }; }
    const batch = await batchById(client, params.batchId, true);
    if (batch.row_version !== params.body.expected_version) throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le lot comptable a changé.");
    if (batch.status === "CANCELLED") throw new HttpError(409, "ACCOUNTING_EXPORT_ALREADY_CANCELLED", "Ce lot est déjà annulé.");
    await client.query(`UPDATE public.accounting_export_source_claims SET released_at=now(),released_by=$2,release_reason=$3 WHERE batch_id=$1::uuid AND released_at IS NULL`, [batch.id,params.actor.userId,params.body.reason]);
    await client.query(`UPDATE public.accounting_export_batches SET status='CANCELLED',row_version=row_version+1,cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3 WHERE id=$1::uuid`, [batch.id,params.actor.userId,params.body.reason]);
    const result = { ...(await batchById(client, batch.id)), idempotent_replay: false };
    await insertGlobalFinanceAudit({ client, actor: params.actor, action: "accounting_export.cancelled", entityType: "accounting_export_batch", entityId: batch.id, details: { batch_number: batch.batch_number, prior_status: batch.status, reason: params.body.reason, correlation_id: batch.correlation_id } });
    await saveReceipt({ client, actor: params.actor, key: receipt.key, hash: receipt.hash, commandType: "ACCOUNTING_EXPORT_CANCEL", aggregateId: batch.id, result });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function repoReexportAccountingBatch(params: { batchId: string; body: ReexportAccountingBatchDTO; actor: FinanceActorContext; idempotencyKey?: string }): Promise<BatchRow & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireReceipt({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: "ACCOUNTING_EXPORT_REEXPORT", payload: { batch_id: params.batchId, ...params.body } });
    if (receipt.replay) { await client.query("COMMIT"); return { ...(receipt.replay as unknown as BatchRow), idempotent_replay: true }; }
    const original = await batchById(client, params.batchId, true);
    if (original.status !== "CANCELLED") throw new HttpError(409, "ACCOUNTING_REEXPORT_REQUIRES_CANCELLED", "Seul un lot annulé peut être réexporté.");
    const mapping = await mappingById(client, params.body.mapping_version_id ?? original.mapping_version_id, true);
    const batch = await persistPreview({ client, actor: params.actor, mapping, reexportOf: original.id, input: { mapping_version_id: mapping.id, period_from: original.period_from, period_to: original.period_to, source_types: original.source_types } });
    const result = { ...batch, idempotent_replay: false };
    await insertGlobalFinanceAudit({ client, actor: params.actor, action: "accounting_export.reexport_previewed", entityType: "accounting_export_batch", entityId: batch.id, details: { original_batch_id: original.id, reason: params.body.reason, mapping_version: mapping.version_code } });
    await saveReceipt({ client, actor: params.actor, key: receipt.key, hash: receipt.hash, commandType: "ACCOUNTING_EXPORT_REEXPORT", aggregateId: batch.id, result });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function repoGetAccountingBatch(id: string): Promise<BatchRow & { reconciliation: unknown }> {
  const client = await pool.connect();
  try {
    const batch = await batchById(client, id);
    const reconciliation = await client.query(
      `SELECT source_type,COUNT(DISTINCT source_id)::int AS source_count,COUNT(*)::int AS line_count,
              COALESCE(SUM(debit),0)::numeric(18,2)::text AS debit,COALESCE(SUM(credit),0)::numeric(18,2)::text AS credit,
              (COALESCE(SUM(debit),0)=COALESCE(SUM(credit),0)) AS balanced
       FROM public.accounting_export_entries WHERE batch_id=$1::uuid GROUP BY source_type ORDER BY source_type`,
      [id]
    );
    return { ...batch, reconciliation: { by_source_type: reconciliation.rows, definition: "Sommes des lignes immuables du lot rapprochées par type de pièce", unit: "devise de la ligne", period: { from: batch.period_from, to: batch.period_to }, source: "accounting_export_entries", freshness_at: batch.generated_at ?? batch.validated_at ?? batch.created_at, reliability: batch.status === "GENERATED" ? "VERIFIED" : "PREVIEW" } };
  } finally { client.release(); }
}

export async function repoListAccountingBatches(): Promise<BatchRow[]> {
  const result = await pool.query<{ id: string }>(`SELECT id::text FROM public.accounting_export_batches ORDER BY created_at DESC LIMIT 100`);
  const client = await pool.connect();
  try {
    const batches: BatchRow[] = [];
    for (const row of result.rows) {
      batches.push(await batchById(client, row.id));
    }
    return batches;
  } finally { client.release(); }
}

export async function repoDownloadAccountingArtifact(id: string): Promise<{ filename: string; content: Buffer; sha256: string }> {
  const result = await pool.query<{ artifact_filename: string | null; artifact_content: Buffer | null; artifact_sha256: string | null; status: string }>(`SELECT artifact_filename,artifact_content,artifact_sha256,status FROM public.accounting_export_batches WHERE id=$1::uuid`, [id]);
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "ACCOUNTING_EXPORT_NOT_FOUND", "Lot comptable introuvable.");
  if (row.status !== "GENERATED" || !row.artifact_filename || !row.artifact_content || !row.artifact_sha256) throw new HttpError(409, "ACCOUNTING_ARTIFACT_NOT_AVAILABLE", "L'artefact n'est disponible qu'après génération.");
  if (sha256Buffer(row.artifact_content) !== row.artifact_sha256) throw new HttpError(500, "ACCOUNTING_ARTIFACT_INTEGRITY_FAILED", "L'intégrité de l'artefact comptable ne peut pas être vérifiée.");
  return { filename: row.artifact_filename, content: row.artifact_content, sha256: row.artifact_sha256 };
}
