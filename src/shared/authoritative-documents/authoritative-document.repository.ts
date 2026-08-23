import type { PoolClient } from "pg";
import crypto from "node:crypto";

import { HttpError } from "../../utils/httpError";
import type { ArchiveQueueItem, AuthoritativePdfArchiveRecord, AuthoritativePdfCreationInput } from "./authoritative-document.types";

type ArchiveRow = {
  id: string; entity_type: string; entity_id: string; document_kind: string; document_version: number | string; render_version: string;
  idempotency_key: string; title: string; original_name: string; source_snapshot: Record<string, unknown>;
  source_revision: string; snapshot_sha256: string; pdf_sha256: string | null; pdf_size_bytes: string | null;
  exact_pdf_bytes: Buffer | null; exact_pdf_sha256: string | null; exact_pdf_size_bytes: string | null;
  ged_document_id: string | null; ged_version_id: string | null; archived_at: string | null; created_at: string; created_by: number | null;
};

function mapArchive(row: ArchiveRow): AuthoritativePdfArchiveRecord {
  return {
    id: String(row.id), entityType: row.entity_type, entityId: row.entity_id,
    documentKind: row.document_kind, documentVersion: Number(row.document_version), renderVersion: row.render_version,
    idempotencyKey: row.idempotency_key, title: row.title, originalName: row.original_name,
    sourceRevision: row.source_revision, sourceSnapshot: row.source_snapshot, snapshotSha256: row.snapshot_sha256,
    exactPdfBytes: row.exact_pdf_bytes ?? undefined,
    exactPdfSha256: row.exact_pdf_sha256,
    exactPdfSizeBytes: row.exact_pdf_size_bytes == null ? null : Number(row.exact_pdf_size_bytes),
    pdfSha256: row.pdf_sha256, pdfSizeBytes: row.pdf_size_bytes == null ? null : Number(row.pdf_size_bytes),
    gedDocumentId: row.ged_document_id, gedVersionId: row.ged_version_id,
    archivedAt: row.archived_at, createdAt: row.created_at, actorUserId: row.created_by,
  };
}

const ARCHIVE_COLUMNS = `id::text, entity_type, entity_id, document_kind, document_version, render_version,
  idempotency_key, title, original_name, source_snapshot, source_revision, snapshot_sha256, pdf_sha256,
  pdf_size_bytes::text, exact_pdf_bytes, exact_pdf_sha256, exact_pdf_size_bytes::text,
  ged_document_id::text, ged_version_id::text, archived_at::text, created_at::text, created_by`;

/** Insert is intentionally idempotent; a repeated create transaction returns the same job. */
export async function repoQueueAuthoritativePdf(
  tx: Pick<PoolClient, "query">,
  input: AuthoritativePdfCreationInput,
  snapshotSha256: string
): Promise<AuthoritativePdfArchiveRecord> {
  let inserted;
  try {
    inserted = await tx.query<ArchiveRow>(
      `INSERT INTO public.authoritative_pdf_archives
         (entity_type, entity_id, document_kind, document_version, render_version, idempotency_key, title, original_name, source_snapshot, source_revision, snapshot_sha256, exact_pdf_bytes, exact_pdf_sha256, exact_pdf_size_bytes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ARCHIVE_COLUMNS}`,
      [input.entityType, input.entityId, input.documentKind, input.documentVersion, input.renderVersion, input.idempotencyKey,
        input.title, input.originalName, JSON.stringify(input.sourceSnapshot), input.sourceRevision, snapshotSha256,
        input.exactPdfBytes ?? null,
        input.exactPdfBytes ? crypto.createHash("sha256").update(input.exactPdfBytes).digest("hex") : null,
        input.exactPdfBytes?.byteLength ?? null,
        input.actorUserId]
    );
  } catch (error) {
    // Aggregate adapters serialise normal issuance, but a residual database
    // race must remain a stable client conflict instead of a raw PG error.
    if ((error as { code?: string; constraint?: string } | null)?.code === "23505" &&
      (error as { constraint?: string }).constraint === "authoritative_pdf_archive_document_version_uq") {
      throw new HttpError(409, "OFFICIAL_DOCUMENT_VERSION_CONFLICT", "Une nouvelle édition a déjà été créée. Rechargez le document.");
    }
    throw error;
  }
  const archive = inserted.rows[0] ?? (await tx.query<ArchiveRow>(
    `SELECT ${ARCHIVE_COLUMNS} FROM public.authoritative_pdf_archives WHERE idempotency_key = $1`, [input.idempotencyKey]
  )).rows[0];
  if (!archive) throw new Error("AUTHORITATIVE_PDF_ARCHIVE_QUEUE_LOOKUP_FAILED");
  const mapped = mapArchive(archive);
  if (
    mapped.snapshotSha256 !== snapshotSha256 || mapped.entityType !== input.entityType ||
    mapped.entityId !== input.entityId || mapped.documentKind !== input.documentKind ||
    mapped.documentVersion !== input.documentVersion || mapped.renderVersion !== input.renderVersion ||
    mapped.title !== input.title || mapped.originalName !== input.originalName || mapped.sourceRevision !== input.sourceRevision ||
    (input.exactPdfBytes != null && (mapped.exactPdfSha256 !== crypto.createHash("sha256").update(input.exactPdfBytes).digest("hex") || mapped.exactPdfSizeBytes !== input.exactPdfBytes.byteLength))
  ) {
    throw new HttpError(409, "OFFICIAL_DOCUMENT_IDEMPOTENCY_CONFLICT", "Cette clé d'idempotence est déjà utilisée avec une autre demande de document.");
  }
  await tx.query(
    `INSERT INTO public.authoritative_pdf_archive_outbox (archive_id, event_key)
     VALUES ($1::uuid, $2)
     ON CONFLICT (archive_id) DO NOTHING`,
    [mapped.id, `authoritative-pdf:${input.idempotencyKey}`]
  );
  return mapped;
}

/**
 * Looks up an already accepted request before an adapter rebuilds its mutable
 * aggregate snapshot. This is deliberately scoped by the caller afterwards:
 * an idempotency key is globally unique, while entity authorization remains
 * the responsibility of the aggregate route/service.
 */
export async function repoFindAuthoritativePdfByIdempotency(
  tx: Pick<PoolClient, "query">,
  idempotencyKey: string
): Promise<AuthoritativePdfArchiveRecord | null> {
  const result = await tx.query<ArchiveRow>(
    `SELECT ${ARCHIVE_COLUMNS}
       FROM public.authoritative_pdf_archives
      WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ? mapArchive(result.rows[0]) : null;
}

/** Claims only durable, pending work. A crashing worker is recoverable by an operator requeue. */
export async function repoClaimAuthoritativePdfWork(
  tx: Pick<PoolClient, "query">,
  workerId: string,
  limit: number
): Promise<ArchiveQueueItem[]> {
  const result = await tx.query<ArchiveRow & { outbox_id: string; claim_token: string }>(
    `WITH candidate AS (
       SELECT o.id FROM public.authoritative_pdf_archive_outbox o
       WHERE (
         o.status IN ('PENDING', 'FAILED') AND o.available_at <= now()
       ) OR (
         o.status = 'PROCESSING' AND o.locked_at < now() - interval '15 minutes'
       )
       ORDER BY o.created_at, o.id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE public.authoritative_pdf_archive_outbox o
         SET status = 'PROCESSING', locked_at = now(), locked_by = $2, claim_token = gen_random_uuid(), attempt_count = attempt_count + 1
         FROM candidate WHERE o.id = candidate.id
       RETURNING o.id::text AS outbox_id, o.archive_id, o.claim_token::text AS claim_token
     )
     SELECT c.outbox_id, c.claim_token, ${ARCHIVE_COLUMNS}
       FROM claimed c JOIN public.authoritative_pdf_archives a ON a.id = c.archive_id`,
    [limit, workerId]
  );
  return result.rows.map((row) => ({ outboxId: String(row.outbox_id), claimToken: String(row.claim_token), archive: mapArchive(row) }));
}

/** Verifies this exact worker lease before any GED/vault side effects begin. */
export async function repoAssertAuthoritativePdfClaim(
  tx: Pick<PoolClient, "query">,
  input: { archiveId: string; outboxId: string; claimToken: string }
): Promise<void> {
  const result = await tx.query(
    `SELECT 1
      FROM public.authoritative_pdf_archive_outbox
      WHERE id = $1::uuid AND archive_id = $2::uuid AND status = 'PROCESSING'
        AND claim_token = $3::uuid
      FOR UPDATE`,
    [input.outboxId, input.archiveId, input.claimToken]
  );
  if (!result.rows[0]) throw new Error("AUTHORITATIVE_PDF_CLAIM_STALE");
}

export async function repoMarkAuthoritativePdfArchived(
  tx: Pick<PoolClient, "query">,
  input: { archiveId: string; outboxId: string; claimToken: string; pdfSha256: string; pdfSizeBytes: number; gedDocumentId: string; gedVersionId: string; actorUserId: number | null }
): Promise<void> {
  const updated = await tx.query(
    `UPDATE public.authoritative_pdf_archives
        SET pdf_sha256 = $2, pdf_size_bytes = $3, ged_document_id = $4::uuid, ged_version_id = $5::uuid, archived_at = now()
      WHERE id = $1::uuid AND archived_at IS NULL`,
    [input.archiveId, input.pdfSha256, input.pdfSizeBytes, input.gedDocumentId, input.gedVersionId]
  );
  if (updated.rowCount !== 1) throw new Error("AUTHORITATIVE_PDF_ARCHIVE_ALREADY_FINALIZED");
  const outboxUpdated = await tx.query(
    `UPDATE public.authoritative_pdf_archive_outbox
        SET status = 'ARCHIVED', archived_at = now(), last_error = NULL,
            locked_at = NULL, locked_by = NULL, claim_token = NULL
      WHERE id = $1::uuid AND archive_id = $2::uuid AND status = 'PROCESSING' AND claim_token = $3::uuid`,
    [input.outboxId, input.archiveId, input.claimToken]
  );
  if (outboxUpdated.rowCount !== 1) throw new Error("AUTHORITATIVE_PDF_OUTBOX_ARCHIVE_TRANSITION_FAILED");
}

export async function repoMarkAuthoritativePdfFailure(
  tx: Pick<PoolClient, "query">,
  input: { outboxId: string; claimToken: string; message: string }
): Promise<void> {
  const updated = await tx.query(
    `UPDATE public.authoritative_pdf_archive_outbox
        SET status = 'FAILED', available_at = now() + interval '5 minutes', last_error = left($2, 1000), locked_at = NULL, locked_by = NULL, claim_token = NULL
      WHERE id = $1::uuid AND status = 'PROCESSING' AND claim_token = $3::uuid`,
    [input.outboxId, input.message, input.claimToken]
  );
  if (updated.rowCount !== 1) throw new Error("AUTHORITATIVE_PDF_OUTBOX_FAILURE_TRANSITION_FAILED");
}

export type AuthoritativePdfListedRecord = AuthoritativePdfArchiveRecord & {
  state: "PENDING" | "PROCESSING" | "ARCHIVED" | "FAILED";
};

export async function repoListAuthoritativePdfs(
  tx: Pick<PoolClient, "query">,
  entityType: string,
  entityId: string,
  documentKind: string
): Promise<AuthoritativePdfListedRecord[]> {
  const result = await tx.query<ArchiveRow & { state: AuthoritativePdfListedRecord["state"] }>(
    `SELECT ${ARCHIVE_COLUMNS}, o.status::text AS state
      FROM public.authoritative_pdf_archives a
       JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id = a.id
      WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.document_kind = $3
      ORDER BY a.created_at DESC, a.document_version DESC`,
    [entityType, entityId, documentKind]
  );
  return result.rows.map((row) => ({ ...mapArchive(row), state: row.state }));
}

export async function repoGetAuthoritativePdf(
  tx: Pick<PoolClient, "query">,
  entityType: string,
  entityId: string,
  archiveId: string,
  documentKind: string
): Promise<AuthoritativePdfListedRecord | null> {
  const result = await tx.query<ArchiveRow & { state: AuthoritativePdfListedRecord["state"] }>(
    `SELECT ${ARCHIVE_COLUMNS}, o.status::text AS state
       FROM public.authoritative_pdf_archives a
       JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id = a.id
      WHERE a.id = $1::uuid AND a.entity_type = $2 AND a.entity_id = $3 AND a.document_kind = $4`,
    [archiveId, entityType, entityId, documentKind]
  );
  const row = result.rows[0];
  return row ? { ...mapArchive(row), state: row.state } : null;
}

export async function repoFindLatestGedDocumentForAuthoritativePdf(
  tx: Pick<PoolClient, "query">,
  entityType: string,
  entityId: string,
  documentKind: string
): Promise<string | null> {
  const result = await tx.query<{ ged_document_id: string }>(
    `SELECT ged_document_id::text
       FROM public.authoritative_pdf_archives
      WHERE entity_type = $1 AND entity_id = $2 AND document_kind = $3
        AND ged_document_id IS NOT NULL
      ORDER BY archived_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [entityType, entityId, documentKind]
  );
  return result.rows[0]?.ged_document_id ?? null;
}

export async function repoFindLatestAuthoritativePdfForEntity(
  tx: Pick<PoolClient, "query">,
  entityType: string,
  entityId: string,
  documentKind: string
): Promise<AuthoritativePdfListedRecord | null> {
  const result = await tx.query<ArchiveRow & { state: AuthoritativePdfListedRecord["state"] }>(
    `SELECT ${ARCHIVE_COLUMNS}, o.status::text AS state
      FROM public.authoritative_pdf_archives a
       JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id = a.id
      WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.document_kind = $3
        AND o.status = 'ARCHIVED'
      ORDER BY a.created_at DESC, a.document_version DESC LIMIT 1`,
    [entityType, entityId, documentKind]
  );
  const row = result.rows[0];
  return row ? { ...mapArchive(row), state: row.state } : null;
}
