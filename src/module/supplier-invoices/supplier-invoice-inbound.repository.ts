import crypto from "node:crypto";

import type { PoolClient } from "pg";

import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import type { NormalizedSupplierInvoice } from "./supplier-invoice.domain";

type Queryer = Pick<PoolClient, "query">;

export type SupplierInvoiceArtifactSeed = Readonly<{
  kind: "ORIGINAL" | "FACTUR_X" | "ATTACHMENT";
  providerKey: string;
  fileName: string;
  mimeType: string;
  contentSha256: string;
  sizeBytes: number;
}>;

export type PendingSupplierInvoiceArtifact = Readonly<{
  id: string;
  supplierInvoiceId: string;
  kind: "ORIGINAL" | "FACTUR_X" | "ATTACHMENT";
  providerKey: string;
  fileName: string;
  mimeType: string;
  contentSha256: string;
  archived: boolean;
}>;

export async function repoGetInboundSyncContext(environment: "sandbox" | "production"): Promise<{
  providerCode: string;
  qualifiedBy: number;
  lastProviderId: number | null;
}> {
  const result = await pool.query<{
    provider_code: string;
    qualified_by: number;
    last_provider_id: string | number | null;
  }>(
    `SELECT c.provider_code,c.qualified_by,sc.last_provider_id
       FROM public.einvoice_provider_connections c
       LEFT JOIN public.super_pdp_sync_cursors sc
         ON sc.provider_code=c.provider_code AND sc.stream='INBOUND_INVOICES'
      WHERE c.environment=$1 AND c.enabled=true AND c.adapter_key='super-pdp'
      LIMIT 1`,
    [environment]
  );
  const row = result.rows[0];
  if (!row || row.qualified_by == null) {
    throw new HttpError(503, "SUPPLIER_INVOICE_PROVIDER_DISABLED", "La réception SUPER PDP n'est pas activée et qualifiée dans cet environnement.");
  }
  return {
    providerCode: row.provider_code,
    qualifiedBy: Number(row.qualified_by),
    lastProviderId: row.last_provider_id == null ? null : Number(row.last_provider_id),
  };
}

export async function repoRecordInboundSyncAttempt(providerCode: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.super_pdp_sync_cursors(provider_code,stream,last_attempt_at)
     VALUES ($1,'INBOUND_INVOICES',now())
     ON CONFLICT(provider_code,stream) DO UPDATE
       SET last_attempt_at=excluded.last_attempt_at,row_version=public.super_pdp_sync_cursors.row_version+1`,
    [providerCode]
  );
}

export async function repoAdvanceInboundSyncCursor(providerCode: string, providerInvoiceId: number): Promise<void> {
  await pool.query(
    `INSERT INTO public.super_pdp_sync_cursors(
       provider_code,stream,last_provider_id,last_attempt_at,last_success_at,last_error_code,last_error_at
     ) VALUES ($1,'INBOUND_INVOICES',$2,now(),now(),NULL,NULL)
     ON CONFLICT(provider_code,stream) DO UPDATE SET
       last_provider_id=GREATEST(COALESCE(public.super_pdp_sync_cursors.last_provider_id,0),excluded.last_provider_id),
       last_attempt_at=now(),last_success_at=now(),last_error_code=NULL,last_error_at=NULL,
       row_version=public.super_pdp_sync_cursors.row_version+1`,
    [providerCode, providerInvoiceId]
  );
}

export async function repoRecordInboundSyncFailure(providerCode: string, errorCode: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.super_pdp_sync_cursors(provider_code,stream,last_attempt_at,last_error_code,last_error_at)
     VALUES ($1,'INBOUND_INVOICES',now(),$2,now())
     ON CONFLICT(provider_code,stream) DO UPDATE SET
       last_attempt_at=now(),last_error_code=excluded.last_error_code,last_error_at=now(),
       row_version=public.super_pdp_sync_cursors.row_version+1`,
    [providerCode, errorCode.slice(0, 120)]
  );
}

async function findSupplierCandidates(tx: Queryer, invoice: NormalizedSupplierInvoice): Promise<string[]> {
  const electronic = invoice.supplierElectronicAddress;
  const result = await tx.query<{ id: string }>(
    `SELECT id::text AS id
       FROM public.fournisseurs
      WHERE actif=true
        AND (
          (cardinality($1::text[]) > 0 AND siren=ANY($1::text[]))
          OR ($2::text IS NOT NULL AND electronic_address_scheme=$2 AND electronic_address_value=$3)
          OR ($4::text IS NOT NULL AND regexp_replace(upper(tva),'[^0-9A-Z]','','g')=$4)
        )
      ORDER BY id`,
    [
      invoice.supplierSirens,
      electronic?.scheme ?? null,
      electronic?.value ?? null,
      invoice.supplierVatIdentifier?.replace(/[^0-9A-Z]/g, "") ?? null,
    ]
  );
  return result.rows.map((row) => row.id);
}

function inboundFormat(mimeType: string, fileName: string): "UBL" | "CII" | "FACTUR_X" {
  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) return "FACTUR_X";
  return /cii|crossindustry/i.test(fileName) ? "CII" : "UBL";
}

export async function repoPersistInboundSupplierInvoice(params: {
  providerCode: string;
  correlationId: string;
  invoice: NormalizedSupplierInvoice;
  original: SupplierInvoiceArtifactSeed;
  artifacts: readonly SupplierInvoiceArtifactSeed[];
}): Promise<{ supplierInvoiceId: string; pendingArtifacts: PendingSupplierInvoiceArtifact[]; replayed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`supplier-invoice:${params.providerCode}:${params.invoice.providerInvoiceId}`]);
    const existing = await client.query<{ id: string }>(
      `SELECT si.id::text AS id
         FROM public.supplier_invoices si
         JOIN public.einvoice_documents d ON d.id=si.einvoice_document_id
        WHERE d.provider_code=$1 AND d.provider_document_id=$2
        LIMIT 1`,
      [params.providerCode, params.invoice.providerInvoiceId]
    );
    let supplierInvoiceId = existing.rows[0]?.id ?? null;
    let replayed = supplierInvoiceId !== null;
    if (!supplierInvoiceId) {
      const candidates = await findSupplierCandidates(client, params.invoice);
      const contentDuplicate = await client.query<{ id: string }>(
        `SELECT si.id::text AS id
           FROM public.supplier_invoices si
           JOIN public.einvoice_documents d ON d.id=si.einvoice_document_id
          WHERE d.source_sha256=$1 AND d.provider_document_id<>$2
          ORDER BY si.received_at LIMIT 1`,
        [params.original.contentSha256, params.invoice.providerInvoiceId]
      );
      const duplicateId = contentDuplicate.rows[0]?.id ?? null;
      let identifiedSupplier = candidates.length === 1 && !duplicateId ? candidates[0]! : null;
      let identificationError: string | null = null;
      if (duplicateId) identificationError = `DUPLICATE_CONTENT:${duplicateId}`;
      else if (candidates.length === 0) identificationError = "SUPPLIER_NOT_FOUND";
      else if (candidates.length > 1) identificationError = "SUPPLIER_AMBIGUOUS";
      if (identifiedSupplier) {
        const legalDuplicate = await client.query<{ id: string }>(
          `SELECT id::text FROM public.supplier_invoices
            WHERE fournisseur_id=$1::uuid AND legal_number=$2 AND document_type=$3
            ORDER BY received_at LIMIT 1`,
          [identifiedSupplier, params.invoice.legalNumber, params.invoice.documentType]
        );
        if (legalDuplicate.rows[0]) {
          identificationError = `DUPLICATE_LEGAL_NUMBER:${legalDuplicate.rows[0].id}`;
          identifiedSupplier = null;
        }
      }

      const document = await client.query<{ id: string }>(
        `INSERT INTO public.einvoice_documents(
           direction,document_type,format,provider_code,provider_document_id,source_sha256,
           content_sha256,attachment_metadata,correlation_id,created_at,updated_at
         ) VALUES ('INBOUND',$1,$2,$3,$4,$5,$5,$6::jsonb,$7::uuid,now(),now())
         RETURNING id::text AS id`,
        [
          params.invoice.documentType,
          inboundFormat(params.original.mimeType, params.original.fileName),
          params.providerCode,
          params.invoice.providerInvoiceId,
          params.original.contentSha256,
          JSON.stringify(params.artifacts.map((artifact) => ({
            kind: artifact.kind,
            provider_key: artifact.providerKey,
            file_name: artifact.fileName,
            mime_type: artifact.mimeType,
            sha256: artifact.contentSha256,
            size_bytes: artifact.sizeBytes,
          }))),
          params.correlationId,
        ]
      );
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.supplier_invoices(
           einvoice_document_id,fournisseur_id,document_type,provider_type_code,legal_number,
           issue_date,payment_due_date,currency,purchase_order_reference,total_without_vat,total_vat,
           total_with_vat,amount_due,vat_breakdown,seller_snapshot,buyer_snapshot,source_snapshot,
           status,identification_error,received_at,identified_at
         ) VALUES (
           $1::uuid,$2::uuid,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,
           $14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20::timestamptz,$21
         ) RETURNING id::text AS id`,
        [
          document.rows[0]!.id,
          identifiedSupplier,
          params.invoice.documentType,
          params.invoice.providerTypeCode,
          params.invoice.legalNumber,
          params.invoice.issueDate,
          params.invoice.paymentDueDate,
          params.invoice.currency,
          params.invoice.purchaseOrderReference,
          params.invoice.totalWithoutVat,
          params.invoice.totalVat,
          params.invoice.totalWithVat,
          params.invoice.amountDue,
          JSON.stringify(params.invoice.vatBreakdown),
          JSON.stringify(params.invoice.sellerSnapshot),
          JSON.stringify(params.invoice.buyerSnapshot),
          JSON.stringify(params.invoice.sourceSnapshot),
          identifiedSupplier ? "IDENTIFIED" : "RECEIVED",
          identificationError,
          params.invoice.providerCreatedAt,
          identifiedSupplier ? new Date() : null,
        ]
      );
      supplierInvoiceId = created.rows[0]!.id;
      for (const line of params.invoice.lines) {
        await client.query(
          `INSERT INTO public.supplier_invoice_lines(
             supplier_invoice_id,provider_line_id,position,designation,quantity,unit_code,unit_price,
             net_amount,vat_category,vat_rate,purchase_order_line_reference,article_buyer_reference,
             article_seller_reference,source_snapshot
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
          [
            supplierInvoiceId,line.providerLineId,line.position,line.designation,line.quantity,line.unitCode,
            line.unitPrice,line.netAmount,line.vatCategory,line.vatRate,line.purchaseOrderLineReference,
            line.articleBuyerReference,line.articleSellerReference,JSON.stringify(line.sourceSnapshot),
          ]
        );
      }
      await client.query(
        `INSERT INTO public.supplier_invoice_decisions(
           supplier_invoice_id,decision,from_status,to_status,snapshot,actor_user_id
         ) VALUES ($1::uuid,$2,'RECEIVED',$2,$3::jsonb,NULL)`,
        [
          supplierInvoiceId,
          identifiedSupplier ? "IDENTIFIED" : "RECEIVED",
          JSON.stringify({
            source: "SUPER_PDP_SYNC",
            supplier_candidates: candidates,
            identification_error: identificationError,
          }),
        ]
      );
      if (identifiedSupplier) {
        await client.query(
          `INSERT INTO public.supplier_invoice_provider_status_outbox(
             supplier_invoice_id,provider_code,provider_document_id,status_code,correlation_id
           ) VALUES ($1::uuid,$2,$3,205,$4::uuid)`,
          [supplierInvoiceId, params.providerCode, params.invoice.providerInvoiceId, crypto.randomUUID()]
        );
      }
    }

    for (const artifact of params.artifacts) {
      await client.query(
        `INSERT INTO public.supplier_invoice_artifacts(
           supplier_invoice_id,kind,provider_key,file_name,mime_type,content_sha256,size_bytes,scan_status
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'PENDING')
         ON CONFLICT(supplier_invoice_id,kind,provider_key) DO NOTHING`,
        [supplierInvoiceId,artifact.kind,artifact.providerKey,artifact.fileName,artifact.mimeType,artifact.contentSha256,artifact.sizeBytes]
      );
    }
    const artifacts = await client.query<{
      id: string;
      kind: PendingSupplierInvoiceArtifact["kind"];
      provider_key: string;
      file_name: string;
      mime_type: string;
      content_sha256: string;
      ged_document_id: string | null;
    }>(
      `SELECT id::text,kind,provider_key,file_name,mime_type,content_sha256,ged_document_id::text
         FROM public.supplier_invoice_artifacts
        WHERE supplier_invoice_id=$1::uuid ORDER BY kind,provider_key`,
      [supplierInvoiceId]
    );
    await client.query("COMMIT");
    return {
      supplierInvoiceId,
      replayed,
      pendingArtifacts: artifacts.rows.map((row) => ({
        id: row.id,
        supplierInvoiceId: supplierInvoiceId!,
        kind: row.kind,
        providerKey: row.provider_key,
        fileName: row.file_name,
        mimeType: row.mime_type,
        contentSha256: row.content_sha256,
        archived: row.ged_document_id !== null,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoMarkInboundArtifactScanFailure(params: {
  artifactId: string;
  status: "REJECTED" | "UNAVAILABLE";
  provider: string;
  signatureVersion?: string;
}): Promise<void> {
  await pool.query(
    `UPDATE public.supplier_invoice_artifacts
        SET scan_status=$2,scan_provider=$3,scan_signature_version=$4
      WHERE id=$1::uuid AND ged_document_id IS NULL`,
    [params.artifactId, params.status, params.provider.slice(0, 80), params.signatureVersion?.slice(0, 160) ?? null]
  );
}

export async function repoInboundInvoiceArtifactsComplete(supplierInvoiceId: string): Promise<boolean> {
  const result = await pool.query<{ complete: boolean }>(
    `SELECT count(*)>0 AND bool_and(ged_document_id IS NOT NULL AND scan_status='CLEAN') AS complete
       FROM public.supplier_invoice_artifacts WHERE supplier_invoice_id=$1::uuid`,
    [supplierInvoiceId]
  );
  return result.rows[0]?.complete === true;
}

export type ClaimedSupplierInvoiceProviderStatus = Readonly<{
  id: string;
  processingToken: string;
  providerCode: string;
  providerDocumentId: string;
  statusCode: 205 | 206 | 208 | 211 | 212;
  details: Array<{ reason?: string }>;
  correlationId: string;
  attemptCount: number;
}>;

export async function repoClaimSupplierInvoiceProviderStatus(): Promise<ClaimedSupplierInvoiceProviderStatus | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const token = crypto.randomUUID();
    const result = await client.query<{
      id: string;
      provider_code: string;
      provider_document_id: string;
      status_code: number;
      details: Array<{ reason?: string }>;
      correlation_id: string;
      attempt_count: number;
    }>(
      `WITH candidate AS (
         SELECT id FROM public.supplier_invoice_provider_status_outbox
          WHERE sent_at IS NULL AND next_attempt_at<=now()
            AND (processing_token IS NULL OR processing_started_at<now()-interval '15 minutes')
          ORDER BY next_attempt_at,created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE public.supplier_invoice_provider_status_outbox o
          SET processing_token=$1::uuid,processing_started_at=now()
         FROM candidate WHERE o.id=candidate.id
       RETURNING o.id::text,o.provider_code,o.provider_document_id,o.status_code,o.details,
                 o.correlation_id::text,o.attempt_count`,
      [token]
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      processingToken: token,
      providerCode: row.provider_code,
      providerDocumentId: row.provider_document_id,
      statusCode: row.status_code as ClaimedSupplierInvoiceProviderStatus["statusCode"],
      details: Array.isArray(row.details) ? row.details : [],
      correlationId: row.correlation_id,
      attemptCount: Number(row.attempt_count),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCompleteSupplierInvoiceProviderStatus(params: {
  id: string;
  processingToken: string;
  providerEventId: string;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE public.supplier_invoice_provider_status_outbox
        SET sent_at=now(),provider_event_id=$3,attempt_count=attempt_count+1,
            processing_token=NULL,processing_started_at=NULL,last_error_code=NULL
      WHERE id=$1::uuid AND processing_token=$2::uuid`,
    [params.id, params.processingToken, params.providerEventId]
  );
  if (result.rowCount !== 1) throw new Error("Supplier invoice provider status claim was lost");
}

export async function repoFailSupplierInvoiceProviderStatus(params: {
  id: string;
  processingToken: string;
  attemptCount: number;
  errorCode: string;
  retryAfterSeconds?: number | null;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE public.supplier_invoice_provider_status_outbox
        SET attempt_count=attempt_count+1,
            next_attempt_at=now()+make_interval(secs=>LEAST(3600,GREATEST(5,$4::integer))),
            processing_token=NULL,processing_started_at=NULL,last_error_code=$3
      WHERE id=$1::uuid AND processing_token=$2::uuid`,
    [
      params.id,
      params.processingToken,
      params.errorCode.slice(0, 120),
      params.retryAfterSeconds ?? 2 ** Math.min(10, 5 + params.attemptCount),
    ]
  );
  if (result.rowCount !== 1) throw new Error("Supplier invoice provider status claim was lost");
}
