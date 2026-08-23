import crypto from "node:crypto";
import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";
import { repoAddLink, repoAddVersion, repoCreateDocumentWithVersion, repoGetGedBlobReferenceState, repoInternalGetVersionContentRef, repoLockGedBlobSha256, repoLogAccess, repoObsoletePreviousApplicable, repoSetCurrentVersion, repoSetVersionStatus, repoUpsertBlob, withGedBlobSha256Coordination, withGedTransaction } from "../../module/ged/repository/ged.repository";
import { cleanupOwnedVaultBlob, computeSha256, readBlob, writeBlob, type VaultBlobOwnership } from "../../module/ged/services/ged-vault.service";
import { assertAuthoritativePdfFilename } from "./authoritative-document.filename";
import { repoAssertAuthoritativePdfClaim, repoFindLatestAuthoritativePdfForEntity, repoFindLatestGedDocumentForAuthoritativePdf, repoGetAuthoritativePdf, repoListAuthoritativePdfs, repoMarkAuthoritativePdfArchived, repoMarkAuthoritativePdfFailure, repoQueueAuthoritativePdf, type AuthoritativePdfListedRecord } from "./authoritative-document.repository";
import type { ArchiveQueueItem, AuthoritativePdfArchiveRecord, AuthoritativePdfCreationInput, AuthoritativePdfProducer } from "./authoritative-document.types";

const PDF_CLASS = "CERP_AUTHORITATIVE_PDF";
const SYSTEM_SNAPSHOT_CLASS = "CERP_SYSTEM_SNAPSHOT";
const PDF_DOMAIN = "CERP";
export const INTERNAL_CREATION_SNAPSHOT_KINDS = new Set([
  "CLIENT_CREATION_SNAPSHOT", "SUPPLIER_CREATION_SNAPSHOT", "CUSTOMER_ORDER_CREATION_SNAPSHOT",
  "OF_CREATION_SNAPSHOT", "TECHNICAL_PIECE_CREATION_SNAPSHOT", "AFFAIR_CREATION_SNAPSHOT", "STOCK_ARTICLE_CREATION_SNAPSHOT",
]);

/** GED storage policy is explicit: no suffix/pattern may silently classify an external document as internal. */
export function authoritativePdfGedPolicy(documentKind: string): { classKey: string; linkRole: string; eventType: string } {
  return INTERNAL_CREATION_SNAPSHOT_KINDS.has(documentKind)
    ? { classKey: SYSTEM_SNAPSHOT_CLASS, linkRole: "CREATION_SNAPSHOT", eventType: "CREATION_SNAPSHOT_ARCHIVED" }
    : { classKey: PDF_CLASS, linkRole: "AUTHORITATIVE_PDF", eventType: "AUTHORITATIVE_PDF_ARCHIVED" };
}
/** Must stay aligned with the generated-PDF GED class in migration #612. */
const MAX_AUTHORITATIVE_PDF_BYTES = 52_428_800;

/** Canonical JSON makes the source snapshot checksum reproducible across retries. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new Error("AUTHORITATIVE_PDF_SNAPSHOT_NOT_JSON");
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("AUTHORITATIVE_PDF_SNAPSHOT_NOT_JSON");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCreationInput(input: AuthoritativePdfCreationInput): void {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(input.entityType)) throw new Error("AUTHORITATIVE_PDF_ENTITY_TYPE_INVALID");
  if (
    !input.entityId.trim() || input.entityId.length > 160 ||
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.documentKind)
  ) throw new Error("AUTHORITATIVE_PDF_IDENTITY_INVALID");
  if (
    !input.renderVersion.trim() || input.renderVersion.length > 64 ||
    !Number.isSafeInteger(input.documentVersion) || input.documentVersion < 1 ||
    !input.idempotencyKey.trim() || input.idempotencyKey.length > 240 ||
    !input.title.trim() || input.title.length > 300 ||
    !input.sourceRevision.trim() || input.sourceRevision.length > 160
  ) throw new Error("AUTHORITATIVE_PDF_INPUT_INVALID");
  assertAuthoritativePdfFilename(input.originalName);
}

/**
 * Call inside the same business CREATE transaction, after authorization and after
 * the aggregate row exists. It never accepts a client snapshot: the producer builds
 * it from authorized server state. The outbox row makes GED filing automatic and durable.
 */
export async function queueCreationPdfArchive(
  tx: Pick<PoolClient, "query">,
  input: AuthoritativePdfCreationInput
): Promise<AuthoritativePdfArchiveRecord> {
  assertCreationInput(input);
  return repoQueueAuthoritativePdf(tx, input, sha256Text(canonicalJson(input.sourceSnapshot)));
}

/** Registers a server-only renderer for one entity family and document kind. No HTTP route bypasses aggregate RBAC. */
export class AuthoritativePdfProducerRegistry {
  private readonly producers = new Map<string, AuthoritativePdfProducer>();
  private key(entityType: string, documentKind: string): string { return `${entityType}\u0000${documentKind}`; }
  register(entityType: string, documentKind: string, producer: AuthoritativePdfProducer): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(entityType)) throw new Error("AUTHORITATIVE_PDF_ENTITY_TYPE_INVALID");
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(documentKind)) throw new Error("AUTHORITATIVE_PDF_DOCUMENT_KIND_INVALID");
    const key = this.key(entityType, documentKind);
    if (this.producers.has(key)) throw new Error("AUTHORITATIVE_PDF_PRODUCER_ALREADY_REGISTERED");
    this.producers.set(key, producer);
  }
  get(entityType: string, documentKind: string): AuthoritativePdfProducer | null {
    return this.producers.get(this.key(entityType, documentKind)) ?? null;
  }
}

export type OfficialPdfDto = {
  id: string;
  kind: string;
  /** Monotonic business document edition, never a renderer implementation label. */
  version: number;
  /** Browser vocabulary; GED outbox states are intentionally hidden here. */
  state: "ISSUED" | "SUPERSEDED" | "REVOKED";
  safe_filename: string;
  byte_sha256: string;
  byte_length: number;
  mime_type: "application/pdf";
  issued_at: string;
  source_revision: string;
  preview_url: string;
  download_url: string;
};

/** Stable UI envelope. Physical storage/worker diagnostics never cross this boundary. */
export type OfficialDocumentGenerationEnvelope = {
  /** `NOT_GENERATED` is distinct from a durable `PENDING` outbox record. */
  state: "NOT_GENERATED" | "PENDING" | "PROCESSING" | "READY" | "FAILED";
  latest_document: OfficialPdfDto | null;
  retryable: boolean;
  failure_code: string | null;
};

function generationState(record: AuthoritativePdfListedRecord | undefined): OfficialDocumentGenerationEnvelope["state"] {
  if (!record) return "NOT_GENERATED";
  return record.state === "ARCHIVED" ? "READY" : record.state;
}

function assertArchivedRecord(record: AuthoritativePdfListedRecord): asserts record is AuthoritativePdfListedRecord & {
  pdfSha256: string; pdfSizeBytes: number; archivedAt: string;
} {
  if (record.state !== "ARCHIVED" || !record.pdfSha256 || !record.pdfSizeBytes || !record.archivedAt) {
    throw new Error("AUTHORITATIVE_PDF_ARCHIVE_INTEGRITY");
  }
}

function asOfficialDto(
  record: AuthoritativePdfListedRecord,
  baseUrl: string,
  state: OfficialPdfDto["state"]
): OfficialPdfDto {
  assertArchivedRecord(record);
  const root = `${baseUrl}/${encodeURIComponent(record.id)}`;
  return {
    id: record.id, kind: record.documentKind, version: record.documentVersion, state,
    safe_filename: record.originalName, byte_sha256: record.pdfSha256, byte_length: record.pdfSizeBytes,
    mime_type: "application/pdf", issued_at: record.archivedAt, source_revision: record.sourceRevision,
    preview_url: `${root}/preview`, download_url: `${root}/download`,
  };
}

function compareArchiveAttempts(left: AuthoritativePdfListedRecord, right: AuthoritativePdfListedRecord): number {
  // PostgreSQL textual timestamps can use different offset/precision forms;
  // lexical comparison would make an older offset-form row hide a newer one.
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && rightCreatedAt !== leftCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }
  // The database guarantees this business edition is unique within the scope.
  // It is also the deterministic fallback for historical non-ISO timestamps.
  return right.documentVersion - left.documentVersion || right.id.localeCompare(left.id);
}

function newestIssued(records: readonly AuthoritativePdfListedRecord[]): AuthoritativePdfListedRecord | undefined {
  return records.filter((record) => record.state === "ARCHIVED").sort(compareArchiveAttempts)[0];
}

/**
 * Stable browser contract: the envelope reports the current generation attempt;
 * `NOT_GENERATED` is reserved for an empty archive collection, while
 * `PENDING` always means a durable outbox record exists. `latest_document`
 * only ever exposes an immutable, byte-complete issuance.
 */
export function officialDocumentGenerationEnvelope(
  records: readonly AuthoritativePdfListedRecord[],
  baseUrl: string
): OfficialDocumentGenerationEnvelope {
  const attempts = [...records].sort(compareArchiveAttempts);
  const state = generationState(attempts[0]);
  const issued = newestIssued(attempts);
  return {
    state,
    latest_document: issued ? asOfficialDto(issued, baseUrl, "ISSUED") : null,
    retryable: state === "FAILED",
    // A detailed worker error can contain data from an external renderer. It is
    // intentionally held in the operator outbox, not returned to a browser.
    failure_code: state === "FAILED" ? "OFFICIAL_DOCUMENT_GENERATION_FAILED" : null,
  };
}

/** Metadata only. Authorization belongs to the entity adapter before this call. */
export async function getOfficialDocumentGenerationEnvelope(params: {
  tx: Pick<PoolClient, "query">; entityType: string; entityId: string; documentKind: string; baseUrl: string;
}): Promise<OfficialDocumentGenerationEnvelope> {
  return officialDocumentGenerationEnvelope(
    await repoListAuthoritativePdfs(params.tx, params.entityType, params.entityId, params.documentKind),
    params.baseUrl
  );
}

/**
 * Legacy internal helper. Route collections must use the generation envelope,
 * so pending/archive-worker diagnostics can never masquerade as issued bytes.
 */
export async function listOfficialPdfDtos(params: { tx: Pick<PoolClient, "query">; entityType: string; entityId: string; documentKind: string; baseUrl: string }): Promise<OfficialPdfDto[]> {
  const records = await repoListAuthoritativePdfs(params.tx, params.entityType, params.entityId, params.documentKind);
  const latest = newestIssued(records);
  return records
    .filter((record) => record.state === "ARCHIVED")
    .map((record) => asOfficialDto(record, params.baseUrl, record.id === latest?.id ? "ISSUED" : "SUPERSEDED"));
}

export async function getOfficialPdfDto(params: { tx: Pick<PoolClient, "query">; entityType: string; entityId: string; documentKind: string; archiveId: string; baseUrl: string }): Promise<OfficialPdfDto | null> {
  const record = await repoGetAuthoritativePdf(params.tx, params.entityType, params.entityId, params.archiveId, params.documentKind);
  if (!record) return null;
  if (record.state !== "ARCHIVED") {
    throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document officiel est en cours de génération.");
  }
  const latest = newestIssued(await repoListAuthoritativePdfs(params.tx, params.entityType, params.entityId, params.documentKind));
  return asOfficialDto(record, params.baseUrl, record.id === latest?.id ? "ISSUED" : "SUPERSEDED");
}

/**
 * Finalize one claimed job in its worker transaction. The archived PDF is linked
 * to the precise entity and logged in GED; neither a path nor a blob key escapes.
 */
export async function archiveClaimedAuthoritativePdf(
  tx: Pick<PoolClient, "query">,
  item: ArchiveQueueItem,
  pdf: Buffer,
  observeOwnership?: (ownership: { sha256: string; ownership: VaultBlobOwnership }) => void
): Promise<void> {
  if (item.archive.archivedAt) return;
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) throw new Error("AUTHORITATIVE_PDF_EMPTY");
  const exact = Buffer.from(pdf);
  if (exact.length > MAX_AUTHORITATIVE_PDF_BYTES) throw new Error("AUTHORITATIVE_PDF_SIZE_EXCEEDED");
  if (exact.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("AUTHORITATIVE_PDF_NOT_PDF");
  await repoAssertAuthoritativePdfClaim(tx, { archiveId: item.archive.id, outboxId: item.outboxId, claimToken: item.claimToken });
  const sha256 = computeSha256(exact);
  await repoLockGedBlobSha256(tx, sha256);
  const stored = await writeBlob(exact);
  if (stored.sha256 !== sha256 || stored.size_bytes !== exact.byteLength) throw new Error("AUTHORITATIVE_PDF_STORAGE_INTEGRITY");
  observeOwnership?.({ sha256, ownership: stored.ownership });
  const blob = await repoUpsertBlob(tx, {
    sha256: stored.sha256, size_bytes: stored.size_bytes, mime_type: "application/pdf",
    storage_key: stored.storage_key, created_by: item.archive.actorUserId,
  });
  const existingDocumentId = await repoFindLatestGedDocumentForAuthoritativePdf(tx, item.archive.entityType, item.archive.entityId, item.archive.documentKind);
  const gedPolicy = authoritativePdfGedPolicy(item.archive.documentKind);
  const changeReason = `Édition ${item.archive.documentVersion}; rendu ${item.archive.renderVersion}; instantané ${item.archive.snapshotSha256}`;
  let documentId: string;
  let versionId: string;
  if (existingDocumentId) {
    const version = await repoAddVersion(tx, { document_id: existingDocumentId, blob_id: blob.id, original_name: item.archive.originalName, change_reason: changeReason, created_by: item.archive.actorUserId });
    documentId = existingDocumentId;
    versionId = version.version_id;
  } else {
    const created = await repoCreateDocumentWithVersion(tx, { class_key: gedPolicy.classKey, domain: PDF_DOMAIN, title: item.archive.title, description: `${item.archive.documentKind} — ${item.archive.entityType}:${item.archive.entityId}`, blob_id: blob.id, original_name: item.archive.originalName, change_reason: changeReason, created_by: item.archive.actorUserId });
    documentId = created.document_id;
    versionId = created.version_id;
  }
  await repoObsoletePreviousApplicable(tx, documentId, versionId);
  await repoSetVersionStatus(tx, versionId, "APPLICABLE", item.archive.actorUserId);
  await repoSetCurrentVersion(tx, documentId, versionId);
  await repoAddLink(tx, { document_id: documentId, entity_type: item.archive.entityType, entity_id: item.archive.entityId, link_role: gedPolicy.linkRole, created_by: item.archive.actorUserId });
  await repoLogAccess(tx, { document_id: documentId, version_id: versionId, event_type: gedPolicy.eventType, actor_id: item.archive.actorUserId, details: { entity_type: item.archive.entityType, entity_id: item.archive.entityId, document_kind: item.archive.documentKind, document_version: item.archive.documentVersion, source_revision: item.archive.sourceRevision, snapshot_sha256: item.archive.snapshotSha256, pdf_sha256: sha256, render_version: item.archive.renderVersion } });
  await repoMarkAuthoritativePdfArchived(tx, { archiveId: item.archive.id, outboxId: item.outboxId, claimToken: item.claimToken, pdfSha256: sha256, pdfSizeBytes: exact.length, gedDocumentId: documentId, gedVersionId: versionId, actorUserId: item.archive.actorUserId });
}

/** A worker invokes this around each claimed item; failures remain durable and retryable. */
export async function processAuthoritativePdfItem(
  tx: Pick<PoolClient, "query">,
  item: ArchiveQueueItem,
  registry: AuthoritativePdfProducerRegistry,
  observeOwnership?: (ownership: { sha256: string; ownership: VaultBlobOwnership }) => void
): Promise<void> {
  const producer = registry.get(item.archive.entityType, item.archive.documentKind);
  // No dynamic entity/document value is retained in a failure record or log.
  if (!producer) throw new Error("AUTHORITATIVE_PDF_PRODUCER_NOT_REGISTERED");
  await archiveClaimedAuthoritativePdf(tx, item, await producer({ archive: item.archive }), observeOwnership);
}

/**
 * Call only from a fresh, confirmed rollback/failure transaction. Keeping this
 * separate avoids attempting an UPDATE after PostgreSQL has marked the archive
 * transaction aborted.
 */
export async function recordAuthoritativePdfItemFailure(
  tx: Pick<PoolClient, "query">,
  item: ArchiveQueueItem,
  error: unknown
): Promise<void> {
  // Keep outbox diagnostics operationally useful without persisting a renderer
  // message, source value, storage path, or dynamic producer identifier.
  const code = error instanceof HttpError && /^[A-Z][A-Z0-9_]{2,120}$/.test(error.code)
    ? error.code
    : error instanceof Error && /^AUTHORITATIVE_PDF_[A-Z0-9_]{2,100}$/.test(error.message)
      ? error.message
      : "AUTHORITATIVE_PDF_ARCHIVE_FAILED";
  await repoMarkAuthoritativePdfFailure(
    tx,
    { outboxId: item.outboxId, claimToken: item.claimToken, message: code }
  );
}

async function cleanupArchiveBlobAfterConfirmedRollback(ownership: { sha256: string; ownership: VaultBlobOwnership } | null): Promise<void> {
  if (!ownership || ownership.ownership.kind === "deduplicated") return;
  await withGedBlobSha256Coordination(ownership.sha256, async (tx) => {
    const reference = await repoGetGedBlobReferenceState(tx, ownership.sha256);
    if (!reference.blob_present && reference.reference_count === 0) await cleanupOwnedVaultBlob(ownership.ownership);
  });
}

/** Processes one already-claimed job with commit/rollback-safe vault compensation. */
export async function runClaimedAuthoritativePdfArchive(
  item: ArchiveQueueItem,
  registry: AuthoritativePdfProducerRegistry
): Promise<void> {
  let ownership: { sha256: string; ownership: VaultBlobOwnership } | null = null;
  try {
    await withGedTransaction(
      (tx) => processAuthoritativePdfItem(tx, item, registry, (value) => { ownership = value; }),
      { afterConfirmedRollback: () => cleanupArchiveBlobAfterConfirmedRollback(ownership) }
    );
  } catch (error) {
    // A lost COMMIT acknowledgement deliberately remains PROCESSING for
    // reconciliation/reclaim; marking it FAILED could duplicate a committed PDF.
    if (error instanceof HttpError && error.code === "GED_COMMIT_UNCERTAIN") throw error;
    const failureTx = await import("../../config/database").then((module) => module.default.connect());
    try {
      await failureTx.query("BEGIN");
      await recordAuthoritativePdfItemFailure(failureTx, item, error);
      await failureTx.query("COMMIT");
    } catch (failureError) {
      try { await failureTx.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw failureError;
    } finally { failureTx.release(); }
    throw error;
  }
}

/**
 * Reads exact archived bytes after the entity adapter has authorized access.
 * The GED audit is committed before opening the vault, so a failed/blocked byte
 * read is still forensically visible without exposing a physical locator.
 */
export async function readOfficialPdfBytes(params: {
  entityType: string; entityId: string; documentKind: string; archiveId: string; actorUserId: number | null;
  eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED" | "AUTHORITATIVE_PDF_SENT";
}): Promise<{ bytes: Buffer; filename: string; sha256: string }> {
  const database = (await import("../../config/database")).default;
  const record = await repoGetAuthoritativePdf(database, params.entityType, params.entityId, params.archiveId, params.documentKind);
  if (!record) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.");
  if (record.state !== "ARCHIVED" || !record.gedVersionId || !record.pdfSha256) {
    throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document officiel est en cours de génération.");
  }
  const reference = await repoInternalGetVersionContentRef(record.gedVersionId);
  if (!reference || reference.document_id !== record.gedDocumentId || reference.sha256 !== record.pdfSha256 || reference.mime_type !== "application/pdf") {
    throw new HttpError(409, "OFFICIAL_DOCUMENT_INTEGRITY", "Le document officiel ne peut pas être restitué de manière vérifiée.");
  }
  await repoLogAccess(database, { document_id: record.gedDocumentId, version_id: record.gedVersionId, event_type: params.eventType, actor_id: params.actorUserId, details: { entity_type: params.entityType, entity_id: params.entityId, archive_id: record.id, pdf_sha256: record.pdfSha256 } });
  const bytes = await readBlob(reference.storage_key, record.pdfSha256).catch(() => {
    throw new HttpError(503, "OFFICIAL_DOCUMENT_UNAVAILABLE", "Le document officiel est temporairement indisponible.");
  });
  if (bytes.byteLength !== record.pdfSizeBytes) throw new HttpError(409, "OFFICIAL_DOCUMENT_INTEGRITY", "Le document officiel ne peut pas être restitué de manière vérifiée.");
  return { bytes, filename: record.originalName, sha256: record.pdfSha256 };
}

export async function readLatestOfficialPdfBytes(params: Omit<Parameters<typeof readOfficialPdfBytes>[0], "archiveId">): Promise<{ bytes: Buffer; filename: string; sha256: string }> {
  const database = (await import("../../config/database")).default;
  const record = await repoFindLatestAuthoritativePdfForEntity(database, params.entityType, params.entityId, params.documentKind);
  if (!record) throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document officiel est en cours de génération.");
  return readOfficialPdfBytes({ ...params, archiveId: record.id });
}

/** Print is an intent audit, deliberately byte-free. */
export async function recordOfficialPdfPrintIntent(params: { entityType: string; entityId: string; documentKind: string; archiveId: string; actorUserId: number | null }): Promise<void> {
  const database = (await import("../../config/database")).default;
  const record = await repoGetAuthoritativePdf(database, params.entityType, params.entityId, params.archiveId, params.documentKind);
  if (!record) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.");
  if (record.state !== "ARCHIVED" || !record.gedDocumentId || !record.gedVersionId) {
    throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document officiel est en cours de génération.");
  }
  await repoLogAccess(database, { document_id: record.gedDocumentId, version_id: record.gedVersionId, event_type: "AUTHORITATIVE_PDF_PRINT_INTENT", actor_id: params.actorUserId, details: { entity_type: params.entityType, entity_id: params.entityId, archive_id: record.id } });
}
