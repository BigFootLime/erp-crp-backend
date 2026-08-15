import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  canonicalJson,
  financeRequestHash,
  normalizeIdempotencyKey,
} from "../domain/finance-policy";
import {
  insertGlobalFinanceAudit,
  type FinanceActorContext,
} from "../repository/workflow.repository.shared";
import {
  DGFiP_INVOICE_STATUSES,
  type DGFiPInvoiceStatusCode,
  type ElectronicInvoiceFormat,
  type ElectronicInvoiceProviderEvent,
  type ElectronicInvoiceSourceDocument,
  type ElectronicInvoiceSubmissionReceipt,
  sha256Hex,
} from "./electronic-invoice.domain";

type DbQueryer = Pick<PoolClient, "query">;

export type ElectronicInvoiceConnection = {
  providerCode: string;
  adapterKey: string;
  environment: "sandbox" | "production";
  supportedFormats: ElectronicInvoiceFormat[];
  qualifiedAt: string;
};

export type ElectronicInvoiceProviderConfiguration = ElectronicInvoiceConnection & {
  enabled: boolean;
  qualificationReference: string | null;
  qualifiedBy: number | null;
  updatedAt: string;
};

export type ElectronicInvoiceDocumentState = {
  id: string;
  invoice_id: number | null;
  credit_note_id: number | null;
  direction: "OUTBOUND" | "INBOUND";
  document_type: "INVOICE" | "CREDIT_NOTE";
  format: ElectronicInvoiceFormat;
  provider_code: string;
  provider_document_id: string | null;
  source_sha256: string;
  content_sha256: string | null;
  external_status: { code: DGFiPInvoiceStatusCode; label: string; mandatory: boolean } | null;
  external_status_at: string | null;
  filing_proof_reference: string | null;
  filing_proof_sha256: string | null;
  retry_count: number;
  next_retry_at: string | null;
  last_error: { code: string; message: string } | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sourceMissingFields(source: ElectronicInvoiceSourceDocument): string[] {
  const missing: string[] = [];
  if (!/^\d{9}$/.test(stringValue(source.issuerSnapshot, "siren") ?? "")) missing.push("issuer.siren");
  if (!stringValue(source.issuerSnapshot, "vat_number")) missing.push("issuer.vat_number");
  if (!stringValue(source.issuerSnapshot, "company_name")) missing.push("issuer.company_name");
  if (!stringValue(source.issuerSnapshot, "address_line_1")) missing.push("issuer.address_line_1");
  if (!stringValue(source.issuerSnapshot, "postal_code")) missing.push("issuer.postal_code");
  if (!stringValue(source.issuerSnapshot, "city")) missing.push("issuer.city");
  if (!stringValue(source.issuerSnapshot, "country")) missing.push("issuer.country");
  const buyerSiret = stringValue(source.customerSnapshot, "siret") ?? "";
  if (!/^\d{14}$/.test(buyerSiret)) missing.push("customer.siret");
  if (!stringValue(source.customerSnapshot, "company_name")) missing.push("customer.company_name");
  const billingAddress = source.customerSnapshot.billing_address;
  if (!isRecord(billingAddress) || !stringValue(billingAddress, "street")) missing.push("customer.billing_address.street");
  if (!isRecord(billingAddress) || !stringValue(billingAddress, "postal_code")) missing.push("customer.billing_address.postal_code");
  if (!isRecord(billingAddress) || !stringValue(billingAddress, "city")) missing.push("customer.billing_address.city");
  if (!isRecord(billingAddress) || !stringValue(billingAddress, "country")) missing.push("customer.billing_address.country");
  if (!/^[A-Z]{3}$/.test(source.currency)) missing.push("currency");
  if (source.lines.length === 0) missing.push("lines");
  source.lines.forEach((line, index) => {
    const required = ["description", "quantity", "unit", "unit_price_ex_tax", "vat_rate", "total_ex_tax", "total_incl_tax"];
    for (const key of required) {
      const value = line[key];
      if ((typeof value !== "string" && typeof value !== "number") || String(value).trim().length === 0) {
        missing.push(`lines[${index}].${key}`);
      }
    }
  });
  return missing;
}

function mapState(row: Record<string, unknown>): ElectronicInvoiceDocumentState {
  const statusCode = row.external_status_code == null ? null : Number(row.external_status_code) as DGFiPInvoiceStatusCode;
  return {
    id: String(row.id),
    invoice_id: row.facture_id == null ? null : Number(row.facture_id),
    credit_note_id: row.avoir_id == null ? null : Number(row.avoir_id),
    direction: String(row.direction) as ElectronicInvoiceDocumentState["direction"],
    document_type: String(row.document_type) as ElectronicInvoiceDocumentState["document_type"],
    format: String(row.format) as ElectronicInvoiceFormat,
    provider_code: String(row.provider_code),
    provider_document_id: row.provider_document_id == null ? null : String(row.provider_document_id),
    source_sha256: String(row.source_sha256),
    content_sha256: row.content_sha256 == null ? null : String(row.content_sha256),
    external_status: statusCode === null ? null : { code: statusCode, ...DGFiP_INVOICE_STATUSES[statusCode] },
    external_status_at: row.external_status_at == null ? null : new Date(String(row.external_status_at)).toISOString(),
    filing_proof_reference: row.filing_proof_reference == null ? null : String(row.filing_proof_reference),
    filing_proof_sha256: row.filing_proof_sha256 == null ? null : String(row.filing_proof_sha256),
    retry_count: Number(row.retry_count),
    next_retry_at: row.next_retry_at == null ? null : new Date(String(row.next_retry_at)).toISOString(),
    last_error: row.last_error_code == null
      ? null
      : { code: String(row.last_error_code), message: String(row.last_error_message ?? "") },
    correlation_id: String(row.correlation_id),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function repoGetElectronicInvoiceConnection(
  environment: "sandbox" | "production",
  queryer: DbQueryer = pool
): Promise<ElectronicInvoiceConnection | null> {
  const result = await queryer.query<{
    provider_code: string;
    adapter_key: string;
    environment: "sandbox" | "production";
    supported_formats: ElectronicInvoiceFormat[];
    qualified_at: string;
  }>(
    `
      SELECT provider_code, adapter_key, environment, supported_formats, qualified_at
      FROM public.einvoice_provider_connections
      WHERE enabled = true AND environment = $1
      LIMIT 1
    `,
    [environment]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    providerCode: row.provider_code,
    adapterKey: row.adapter_key,
    environment: row.environment,
    supportedFormats: row.supported_formats,
    qualifiedAt: new Date(row.qualified_at).toISOString(),
  };
}

export async function repoGetElectronicInvoiceProviderConfiguration(
  environment: "sandbox" | "production",
  queryer: DbQueryer = pool
): Promise<ElectronicInvoiceProviderConfiguration | null> {
  const result = await queryer.query<{
    provider_code: string;
    adapter_key: string;
    environment: "sandbox" | "production";
    enabled: boolean;
    supported_formats: ElectronicInvoiceFormat[];
    credential_reference: Record<string, unknown>;
    qualified_at: string | null;
    qualified_by: number | null;
    updated_at: string;
  }>(
    `SELECT provider_code, adapter_key, environment, enabled, supported_formats,
            credential_reference, qualified_at, qualified_by, updated_at
       FROM public.einvoice_provider_connections
      WHERE provider_code = $1
      LIMIT 1`,
    [`super-pdp-${environment}`]
  );
  const row = result.rows[0];
  if (!row) return null;
  const reference = row.credential_reference?.qualification_reference;
  return {
    providerCode: row.provider_code,
    adapterKey: row.adapter_key,
    environment: row.environment,
    enabled: row.enabled,
    supportedFormats: row.supported_formats,
    qualificationReference: typeof reference === "string" ? reference : null,
    qualifiedAt: row.qualified_at ? new Date(row.qualified_at).toISOString() : "",
    qualifiedBy: row.qualified_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function repoActivateSuperPdpConnection(params: {
  environment: "sandbox" | "production";
  formats: ElectronicInvoiceFormat[];
  qualificationReference: string;
  authMode: "client_credentials" | "authorization_code";
  actor: FinanceActorContext;
  idempotencyKeyRaw: string | undefined;
}): Promise<ElectronicInvoiceProviderConfiguration & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKeyRaw);
    const requestHash = financeRequestHash("EINVOICE_PROVIDER_ACTIVATE", {
      environment: params.environment,
      formats: [...params.formats].sort(),
      qualification_reference: params.qualificationReference,
      auth_mode: params.authMode,
    });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `einvoice-provider:${params.environment}`,
    ]);
    const previous = await client.query<{ request_hash: string; result_payload: ElectronicInvoiceProviderConfiguration }>(
      `SELECT request_hash, result_payload
         FROM public.einvoice_command_receipts
        WHERE actor_user_id = $1 AND idempotency_key = $2`,
      [params.actor.userId, idempotencyKey]
    );
    const replay = previous.rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.");
      }
      await client.query("COMMIT");
      return { ...replay.result_payload, idempotent_replay: true };
    }
    const providerCode = `super-pdp-${params.environment}`;
    const active = await client.query<{ provider_code: string }>(
      `SELECT provider_code FROM public.einvoice_provider_connections
        WHERE environment = $1 AND enabled = true AND provider_code <> $2
        FOR UPDATE`,
      [params.environment, providerCode]
    );
    if (active.rows[0]) {
      throw new HttpError(
        409,
        "EINVOICE_PROVIDER_ALREADY_ACTIVE",
        `Le prestataire ${active.rows[0].provider_code} est déjà actif dans cet environnement.`
      );
    }
    await client.query(
      `INSERT INTO public.einvoice_provider_connections (
         provider_code, adapter_key, environment, enabled, supported_formats,
         credential_reference, qualified_at, qualified_by
       ) VALUES ($1,'super-pdp',$2,true,$3,$4::jsonb,now(),$5)
       ON CONFLICT (provider_code) DO UPDATE SET
         adapter_key = EXCLUDED.adapter_key,
         environment = EXCLUDED.environment,
         enabled = true,
         supported_formats = EXCLUDED.supported_formats,
         credential_reference = EXCLUDED.credential_reference,
         qualified_at = now(),
         qualified_by = EXCLUDED.qualified_by,
         updated_at = now()`,
      [
        providerCode,
        params.environment,
        params.formats,
        JSON.stringify({
          auth_mode: params.authMode,
          client_id_env: "SUPER_PDP_CLIENT_ID",
          client_secret_env: params.authMode === "client_credentials" ? "SUPER_PDP_CLIENT_SECRET" : null,
          tenant_token_vault: params.authMode === "authorization_code" ? "required" : null,
          qualification_reference: params.qualificationReference,
        }),
        params.actor.userId,
      ]
    );
    const configuration = await repoGetElectronicInvoiceProviderConfiguration(params.environment, client);
    if (!configuration) throw new Error("SUPER PDP activation did not persist");
    await client.query(
      `INSERT INTO public.einvoice_command_receipts (
         actor_user_id, idempotency_key, request_hash, command_type,
         document_id, result_payload, correlation_id
       ) VALUES ($1,$2,$3,'EINVOICE_PROVIDER_ACTIVATE',NULL,$4::jsonb,$5::uuid)`,
      [params.actor.userId, idempotencyKey, requestHash, JSON.stringify(configuration), crypto.randomUUID()]
    );
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "EINVOICE_PROVIDER_ACTIVATED",
      entityType: "EINVOICE_PROVIDER",
      entityId: providerCode,
      details: {
        environment: params.environment,
        formats: params.formats,
        auth_mode: params.authMode,
        qualification_reference: params.qualificationReference,
      },
    });
    await client.query("COMMIT");
    return { ...configuration, idempotent_replay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoDeactivateSuperPdpConnection(params: {
  environment: "sandbox" | "production";
  reason: string;
  actor: FinanceActorContext;
}): Promise<ElectronicInvoiceProviderConfiguration | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const providerCode = `super-pdp-${params.environment}`;
    await client.query(
      `UPDATE public.einvoice_provider_connections
          SET enabled = false, updated_at = now()
        WHERE provider_code = $1`,
      [providerCode]
    );
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "EINVOICE_PROVIDER_DEACTIVATED",
      entityType: "EINVOICE_PROVIDER",
      entityId: providerCode,
      details: { environment: params.environment, reason: params.reason },
    });
    const configuration = await repoGetElectronicInvoiceProviderConfiguration(params.environment, client);
    await client.query("COMMIT");
    return configuration;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoLoadElectronicInvoiceSource(
  invoiceId: number,
  queryer: DbQueryer = pool,
  lock = false
): Promise<ElectronicInvoiceSourceDocument> {
  const result = await queryer.query<{
    id: number;
    numero: string;
    date_emission: string;
    date_echeance: string | null;
    currency: string;
    issuer_snapshot: Record<string, unknown> | null;
    client_snapshot: Record<string, unknown> | null;
    total_ht: string;
    total_tax: string;
    total_ttc: string;
    document_status: string;
    lines: Array<Record<string, unknown>>;
  }>(
    `
      SELECT
        f.id::int AS id,
        f.numero,
        f.date_emission::text,
        f.date_echeance::text,
        upper(f.currency) AS currency,
        f.issuer_snapshot,
        f.client_snapshot,
        f.total_ht::text,
        f.total_tax::text,
        f.total_ttc::text,
        f.document_status,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', fl.id,
            'order', fl.ordre,
            'description', fl.designation,
            'item_code', fl.code_piece,
            'quantity', fl.quantite::text,
            'unit', fl.unite,
            'unit_price_ex_tax', fl.prix_unitaire_ht::text,
            'discount_percent', fl.remise_ligne::text,
            'vat_rate', fl.taux_tva::text,
            'total_ex_tax', fl.total_ht::text,
            'total_incl_tax', fl.total_ttc::text
          ) ORDER BY fl.ordre, fl.id)
          FROM public.facture_ligne fl
          WHERE fl.facture_id = f.id
        ), '[]'::jsonb) AS lines
      FROM public.facture f
      WHERE f.id = $1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [invoiceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  if (row.document_status !== "ISSUED") {
    throw new HttpError(
      409,
      "EINVOICE_SOURCE_NOT_ISSUED",
      "Seule une facture légalement émise et immuable peut être transmise à une Plateforme Agréée."
    );
  }
  const source: ElectronicInvoiceSourceDocument = {
    invoiceId: row.id,
    creditNoteId: null,
    documentType: "INVOICE",
    legalNumber: row.numero,
    issueDate: row.date_emission,
    dueDate: row.date_echeance,
    currency: row.currency,
    issuerSnapshot: row.issuer_snapshot ?? {},
    customerSnapshot: row.client_snapshot ?? {},
    lines: row.lines,
    totals: { net: row.total_ht, tax: row.total_tax, gross: row.total_ttc },
  };
  const missing = sourceMissingFields(source);
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "EINVOICE_REQUIRED_DATA_MISSING",
      "La facture ne contient pas toutes les données obligatoires pour une transmission électronique.",
      { missing }
    );
  }
  return source;
}

export async function repoGetElectronicInvoiceState(invoiceId: number): Promise<ElectronicInvoiceDocumentState | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM public.einvoice_documents WHERE facture_id = $1 AND direction = 'OUTBOUND' LIMIT 1`,
    [invoiceId]
  );
  return result.rows[0] ? mapState(result.rows[0]) : null;
}

export async function repoListElectronicInvoiceReconciliationCandidates(
  environment: "sandbox" | "production",
  limit = 25
): Promise<Array<{ state: ElectronicInvoiceDocumentState; adapterKey: string }>> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await pool.query<Record<string, unknown> & { adapter_key: string }>(
    `SELECT d.*, c.adapter_key
       FROM public.einvoice_documents d
       JOIN public.einvoice_provider_connections c ON c.provider_code = d.provider_code
      WHERE c.enabled = true
        AND c.environment = $1
        AND d.provider_document_id IS NOT NULL
        AND (d.external_status_code IS NULL OR d.external_status_code NOT IN (210,212,213))
      ORDER BY d.updated_at, d.created_at
      LIMIT $2`,
    [environment, boundedLimit]
  );
  return result.rows.map((row) => ({ state: mapState(row), adapterKey: row.adapter_key }));
}

export async function repoQueueElectronicInvoice(params: {
  invoiceId: number;
  format: ElectronicInvoiceFormat;
  environment: "sandbox" | "production";
  actor: FinanceActorContext;
  idempotencyKeyRaw: string | undefined;
}): Promise<ElectronicInvoiceDocumentState & { idempotent_replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connection = await repoGetElectronicInvoiceConnection(params.environment, client);
    if (!connection) {
      throw new HttpError(
        503,
        "EINVOICE_PROVIDER_NOT_CONFIGURED",
        "Aucune Plateforme Agréée qualifiée n'est activée pour cet environnement."
      );
    }
    if (!connection.supportedFormats.includes(params.format)) {
      throw new HttpError(
        422,
        "EINVOICE_FORMAT_UNSUPPORTED",
        "Le format demandé n'est pas qualifié pour la Plateforme Agréée active."
      );
    }
    const source = await repoLoadElectronicInvoiceSource(params.invoiceId, client, true);
    const sourceHash = sha256Hex(canonicalJson(source));
    const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKeyRaw);
    const requestHash = financeRequestHash("EINVOICE_QUEUE", {
      invoice_id: params.invoiceId,
      format: params.format,
      environment: params.environment,
      source_sha256: sourceHash,
    });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `einvoice:${params.actor.userId}:${idempotencyKey}`,
    ]);
    const receipt = await client.query<{ request_hash: string; document_id: string }>(
      `SELECT request_hash, document_id::text FROM public.einvoice_command_receipts WHERE actor_user_id = $1 AND idempotency_key = $2`,
      [params.actor.userId, idempotencyKey]
    );
    const existingReceipt = receipt.rows[0];
    if (existingReceipt) {
      if (existingReceipt.request_hash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.");
      }
      const replay = await client.query<Record<string, unknown>>(
        `SELECT * FROM public.einvoice_documents WHERE id = $1::uuid`,
        [existingReceipt.document_id]
      );
      const replayRow = replay.rows[0];
      if (!replayRow) throw new Error("Electronic invoice idempotency receipt has no document");
      await client.query("COMMIT");
      return { ...mapState(replayRow), idempotent_replay: true };
    }
    const correlationId = crypto.randomUUID();
    const inserted = await client.query<Record<string, unknown>>(
      `
        INSERT INTO public.einvoice_documents (
          direction, document_type, format, facture_id, provider_code,
          source_sha256, content_sha256, correlation_id, created_by, next_retry_at
        ) VALUES ('OUTBOUND','INVOICE',$1,$2,$3,$4,NULL,$5::uuid,$6,now())
        ON CONFLICT (facture_id) WHERE direction = 'OUTBOUND' AND facture_id IS NOT NULL
        DO UPDATE SET updated_at = public.einvoice_documents.updated_at
        RETURNING *
      `,
      [params.format, params.invoiceId, connection.providerCode, sourceHash, correlationId, params.actor.userId]
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Failed to queue electronic invoice");
    if (String(row.source_sha256) !== sourceHash || String(row.provider_code) !== connection.providerCode) {
      throw new HttpError(
        409,
        "EINVOICE_ALREADY_QUEUED_DIFFERENT_SOURCE",
        "Cette facture a déjà une transmission électronique avec une autre source ou un autre prestataire."
      );
    }
    const state = mapState(row);
    await client.query(
      `
        INSERT INTO public.einvoice_command_receipts (
          actor_user_id, idempotency_key, request_hash, command_type,
          document_id, result_payload, correlation_id
        ) VALUES ($1,$2,$3,'EINVOICE_QUEUE',$4::uuid,$5::jsonb,$6::uuid)
      `,
      [params.actor.userId, idempotencyKey, requestHash, state.id, JSON.stringify(state), correlationId]
    );
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "EINVOICE_QUEUED",
      entityType: "FACTURE",
      entityId: String(params.invoiceId),
      details: {
        electronic_invoice_document_id: state.id,
        provider_code: connection.providerCode,
        format: params.format,
        source_sha256: sourceHash,
        correlation_id: correlationId,
      },
    });
    await client.query("COMMIT");
    return { ...state, idempotent_replay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ClaimedElectronicInvoice = {
  state: ElectronicInvoiceDocumentState;
  processingToken: string;
  providerAdapterKey: string;
  environment: "sandbox" | "production";
  source: ElectronicInvoiceSourceDocument;
};

export async function repoClaimElectronicInvoice(environment: "sandbox" | "production"): Promise<ClaimedElectronicInvoice | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const token = crypto.randomUUID();
    const claimed = await client.query<Record<string, unknown> & { adapter_key: string; environment: "sandbox" | "production" }>(
      `
        WITH candidate AS (
          SELECT d.id
          FROM public.einvoice_documents d
          JOIN public.einvoice_provider_connections c ON c.provider_code = d.provider_code
          WHERE d.direction = 'OUTBOUND'
            AND c.enabled = true
            AND c.environment = $1
            AND d.provider_document_id IS NULL
            AND d.next_retry_at IS NOT NULL
            AND d.next_retry_at <= now()
            AND (d.processing_token IS NULL OR d.processing_started_at < now() - interval '15 minutes')
          ORDER BY d.next_retry_at, d.created_at
          FOR UPDATE OF d SKIP LOCKED
          LIMIT 1
        )
        UPDATE public.einvoice_documents d
        SET processing_token = $2::uuid,
            processing_started_at = now(),
            updated_at = now()
        FROM candidate, public.einvoice_provider_connections c
        WHERE d.id = candidate.id AND c.provider_code = d.provider_code
        RETURNING d.*, c.adapter_key, c.environment
      `,
      [environment, token]
    );
    const row = claimed.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const invoiceId = row.facture_id == null ? null : Number(row.facture_id);
    if (!invoiceId) throw new Error("Outbound electronic invoice claim has no invoice source");
    const source = await repoLoadElectronicInvoiceSource(invoiceId, client, false);
    await client.query("COMMIT");
    return {
      state: mapState(row),
      processingToken: token,
      providerAdapterKey: row.adapter_key,
      environment: row.environment,
      source,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRecordElectronicInvoiceSuccess(params: {
  documentId: string;
  processingToken: string;
  receipt: ElectronicInvoiceSubmissionReceipt;
  contentSha256: string;
  startedAt: Date;
  finishedAt: Date;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ retry_count: number; correlation_id: string }>(
      `SELECT retry_count, correlation_id::text FROM public.einvoice_documents WHERE id = $1::uuid AND processing_token = $2::uuid FOR UPDATE`,
      [params.documentId, params.processingToken]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Electronic invoice processing claim was lost");
    const attemptNo = row.retry_count + 1;
    await client.query(
      `
        INSERT INTO public.einvoice_submission_attempts (
          document_id, operation, attempt_no, outcome, provider_request_id,
          retryable, started_at, finished_at, correlation_id
        ) VALUES ($1::uuid,'SUBMIT',$2,'SUCCEEDED',$3,false,$4,$5,$6::uuid)
      `,
      [params.documentId, attemptNo, params.receipt.providerRequestId, params.startedAt, params.finishedAt, row.correlation_id]
    );
    const updated = await client.query(
      `
        UPDATE public.einvoice_documents
        SET provider_document_id = $3,
            content_sha256 = $4,
            external_status_code = $5,
            external_status_at = $6,
            filing_proof_reference = $7,
            filing_proof_sha256 = $8,
            retry_count = $9,
            next_retry_at = NULL,
            processing_token = NULL,
            processing_started_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = now()
        WHERE id = $1::uuid AND processing_token = $2::uuid
      `,
      [
        params.documentId,
        params.processingToken,
        params.receipt.providerDocumentId,
        params.contentSha256,
        params.receipt.statusCode,
        params.receipt.acceptedAt,
        params.receipt.filingProofReference,
        params.receipt.filingProofSha256,
        attemptNo,
      ]
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error("Electronic invoice success update lost its claim");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRecordElectronicInvoiceFailure(params: {
  documentId: string;
  processingToken: string;
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
  retryable: boolean;
  delaySeconds: number | null;
  startedAt: Date;
  finishedAt: Date;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ retry_count: number; correlation_id: string }>(
      `SELECT retry_count, correlation_id::text FROM public.einvoice_documents WHERE id = $1::uuid AND processing_token = $2::uuid FOR UPDATE`,
      [params.documentId, params.processingToken]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Electronic invoice processing claim was lost");
    const attemptNo = row.retry_count + 1;
    const nextRetryAt = params.retryable && params.delaySeconds !== null
      ? new Date(params.finishedAt.getTime() + params.delaySeconds * 1000)
      : null;
    await client.query(
      `
        INSERT INTO public.einvoice_submission_attempts (
          document_id, operation, attempt_no, outcome, http_status, retryable,
          error_code, error_message, started_at, finished_at, next_retry_at, correlation_id
        ) VALUES ($1::uuid,'SUBMIT',$2,'FAILED',$3,$4,$5,$6,$7,$8,$9,$10::uuid)
      `,
      [params.documentId, attemptNo, params.httpStatus, params.retryable, params.errorCode, params.errorMessage, params.startedAt, params.finishedAt, nextRetryAt, row.correlation_id]
    );
    await client.query(
      `
        UPDATE public.einvoice_documents
        SET retry_count = $3,
            next_retry_at = $4,
            processing_token = NULL,
            processing_started_at = NULL,
            last_error_code = $5,
            last_error_message = $6,
            updated_at = now()
        WHERE id = $1::uuid AND processing_token = $2::uuid
      `,
      [params.documentId, params.processingToken, attemptNo, nextRetryAt, params.errorCode, params.errorMessage]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoApplyElectronicInvoiceProviderEvent(params: {
  providerCode: string;
  event: ElectronicInvoiceProviderEvent;
  payloadSha256: string;
  signatureVerified: boolean | null;
  correlationId: string;
  requestId: string;
  actor?: FinanceActorContext;
}): Promise<{ documentId: string; replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ document_id: string; provider_payload_sha256: string }>(
      `SELECT document_id::text, provider_payload_sha256 FROM public.einvoice_provider_events WHERE provider_code = $1 AND provider_event_id = $2 FOR UPDATE`,
      [params.providerCode, params.event.providerEventId]
    );
    const previous = existing.rows[0];
    if (previous) {
      if (previous.provider_payload_sha256 !== params.payloadSha256) {
        throw new HttpError(409, "EINVOICE_WEBHOOK_EVENT_CONFLICT", "Un identifiant d'événement prestataire a été réutilisé avec un contenu différent.");
      }
      await client.query("COMMIT");
      return { documentId: previous.document_id, replay: true };
    }
    let document = await client.query<{ id: string }>(
      `SELECT id::text FROM public.einvoice_documents WHERE provider_code = $1 AND provider_document_id = $2 FOR UPDATE`,
      [params.providerCode, params.event.providerDocumentId]
    );
    if (!document.rows[0] && params.event.direction === "INBOUND") {
      document = await client.query<{ id: string }>(
        `
          INSERT INTO public.einvoice_documents (
            direction, document_type, format, facture_id, avoir_id, provider_code,
            provider_document_id, source_sha256, content_sha256, content_storage_reference,
            attachment_metadata, external_status_code,
            external_status_at, filing_proof_reference, filing_proof_sha256,
            correlation_id, created_by
          ) VALUES ('INBOUND',$1,$2,$3,$4,$5,$6,$7,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::uuid,NULL)
          RETURNING id::text
        `,
        [
          params.event.documentType,
          params.event.format,
          params.event.invoiceId,
          params.event.creditNoteId,
          params.providerCode,
          params.event.providerDocumentId,
          params.event.documentSha256 ?? params.payloadSha256,
          params.event.contentStorageReference,
          JSON.stringify(params.event.attachments),
          params.event.statusCode,
          params.event.occurredAt,
          params.event.filingProofReference,
          params.event.filingProofSha256,
          params.correlationId,
        ]
      );
    }
    const documentId = document.rows[0]?.id;
    if (!documentId) throw new HttpError(404, "EINVOICE_DOCUMENT_NOT_FOUND", "Document électronique prestataire introuvable.");
    await client.query(
      `
        INSERT INTO public.einvoice_provider_events (
          document_id, provider_code, provider_event_id, provider_payload_sha256,
          external_status_code, occurred_at, rejection_code, rejection_message,
          signature_verified, filing_proof_reference, filing_proof_sha256,
          correlation_id, request_id
        ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,$13)
      `,
      [
        documentId,
        params.providerCode,
        params.event.providerEventId,
        params.payloadSha256,
        params.event.statusCode,
        params.event.occurredAt,
        params.event.rejectionCode,
        params.event.rejectionMessage,
        params.signatureVerified,
        params.event.filingProofReference,
        params.event.filingProofSha256,
        params.correlationId,
        params.requestId,
      ]
    );
    await client.query(
      `
        UPDATE public.einvoice_documents
        SET external_status_code = $2,
            external_status_at = $3,
            filing_proof_reference = COALESCE($4, filing_proof_reference),
            filing_proof_sha256 = COALESCE($5, filing_proof_sha256),
            last_error_code = CASE WHEN $2 IN (210,213) THEN COALESCE($6, 'EINVOICE_REJECTION_REASON_UNAVAILABLE') ELSE NULL END,
            last_error_message = CASE WHEN $2 IN (210,213) THEN COALESCE($7, 'Le prestataire n''a pas fourni de motif structuré.') ELSE NULL END,
            updated_at = now()
        WHERE id = $1::uuid
          AND (external_status_at IS NULL OR external_status_at <= $3)
      `,
      [documentId, params.event.statusCode, params.event.occurredAt, params.event.filingProofReference, params.event.filingProofSha256, params.event.rejectionCode, params.event.rejectionMessage]
    );
    if (params.actor) {
      await insertGlobalFinanceAudit({
        client,
        actor: params.actor,
        action: "EINVOICE_RECONCILED",
        entityType: params.event.documentType === "INVOICE" ? "FACTURE" : "AVOIR",
        entityId: String(params.event.invoiceId ?? params.event.creditNoteId ?? documentId),
        details: {
          electronic_invoice_document_id: documentId,
          provider_code: params.providerCode,
          provider_event_id: params.event.providerEventId,
          external_status_code: params.event.statusCode,
          correlation_id: params.correlationId,
        },
      });
    }
    await client.query("COMMIT");
    return { documentId, replay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
