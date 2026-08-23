// GED centrale CERP (ADR-0037) — accès aux données.
//
// Deux principes structurent ce fichier :
//
// 1. Les SELECT ne remontent JAMAIS `storage_key`. Les fonctions internes qui en
//    ont besoin (téléchargement) sont préfixées `repoInternal*` et leur retour
//    ne transite jamais tel quel vers un contrôleur.
//
// 2. Le module dégrade proprement si son schéma n'est pas encore appliqué :
//    une table absente (42P01) devient un 503 explicite « GED non installée »
//    plutôt qu'un 500 opaque. Un déploiement de code en avance sur le patch ne
//    doit pas donner l'impression que l'ERP est cassé.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import type { UploadCommitReconciliation } from "../../../shared/uploads/upload-transaction";
import { HttpError } from "../../../utils/httpError";
import { formatDocumentCode, type GedVersionStatus } from "../domain/ged-policy";
import type {
  GedAccessEvent,
  GedDocumentClass,
  GedDocumentDetail,
  GedDocumentLink,
  GedDocumentSummary,
  GedDocumentVersion,
  GedListFilters,
  GedListResult,
  GedQuarantineItem,
  GedQuarantineStatus,
  GedRetentionHold,
  GedScanStatus,
} from "../types/ged.types";

const UNDEFINED_TABLE = "42P01";

export function isGedSchemaMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/** Convertit une table manquante en 503 lisible ; laisse passer le reste. */
function rethrowGed(err: unknown): never {
  if (isGedSchemaMissing(err)) {
    throw new HttpError(
      503,
      "GED_NOT_INSTALLED",
      "Le module GED n'est pas encore installé sur cette base (patch 20260727_ged_core non appliqué)."
    );
  }
  throw err;
}

export class GedCommitUncertainError<T> extends HttpError {
  readonly transactionResult: T;
  readonly originalError: unknown;

  constructor(transactionResult: T, originalError: unknown) {
    super(
      503,
      "GED_COMMIT_UNCERTAIN",
      "Le résultat du COMMIT GED doit être rapproché avant toute compensation de fichier."
    );
    this.transactionResult = transactionResult;
    this.originalError = originalError;
  }
}

export class GedRollbackUncertainError extends HttpError {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      503,
      "GED_ROLLBACK_UNCERTAIN",
      "Le rollback GED n’a pas pu être confirmé ; le fichier est préservé pour rapprochement."
    );
    this.originalError = originalError;
  }
}

export class GedBlobCleanupUncertainError extends HttpError {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      503,
      "GED_BLOB_CLEANUP_UNCERTAIN",
      "Le rapprochement du blob GED n'a pas pu être confirmé ; le fichier est préservé pour intervention."
    );
    this.originalError = originalError;
  }
}

export type GedTransactionHooks = Readonly<{
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
  afterConfirmedRollback?: () => void | Promise<void>;
  afterRollbackUncertain?: () => void | Promise<void>;
}>;

export async function withGedTransaction<T>(
  fn: (tx: PoolClient) => Promise<T>,
  hooks: GedTransactionHooks = {}
): Promise<T> {
  let client!: PoolClient;
  let released = false;
  const release = (destroy = false) => {
    if (!client || released) return;
    released = true;
    client.release(destroy);
  };
  try {
    client = await pool.connect();
    await client.query("BEGIN");
  } catch (err) {
    release(true);
    await hooks.afterConfirmedRollback?.();
    return rethrowGed(err);
  }
  try {
    let out: T;
    try {
      out = await fn(client);
      await hooks.beforeCommit?.();
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        release(true);
        await hooks.afterRollbackUncertain?.();
        throw new GedRollbackUncertainError(err);
      }
      // The advisory transaction locks are released by ROLLBACK. Return the
      // client before compensation opens its own fresh transaction; otherwise
      // a saturated pool could deadlock with every failed writer waiting for a
      // cleanup connection while still retaining its writer connection.
      release();
      await hooks.afterConfirmedRollback?.();
      return rethrowGed(err);
    }

    try {
      await client.query("COMMIT");
    } catch (err) {
      // Never issue ROLLBACK after COMMIT was sent: PostgreSQL may have applied
      // it and only the acknowledgement may have been lost.
      release(true);
      throw new GedCommitUncertainError(out, err);
    }
    await hooks.afterCommit?.();
    return out;
  } finally {
    release();
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

type ActorRow = { id: number | null; username: string | null; name: string | null; surname: string | null };

function mapActor(row: ActorRow | null | undefined) {
  if (!row?.id || !row.username) return null;
  const label = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean).join(" ").trim();
  return { id: row.id, username: row.username, label: label || row.username };
}

const VERSION_SELECT = `
  v.id::text                       AS id,
  v.document_id::text              AS document_id,
  v.version_number::int            AS version_number,
  v.status::text                   AS status,
  v.original_name                  AS original_name,
  b.mime_type                      AS mime_type,
  b.size_bytes::bigint::text       AS size_bytes,
  b.sha256                         AS sha256,
  v.change_reason                  AS change_reason,
  v.created_at::text               AS created_at,
  v.submitted_at::text             AS submitted_at,
  v.approved_at::text              AS approved_at,
  v.published_at::text             AS published_at,
  v.obsoleted_at::text             AS obsoleted_at,
  s.scan_status                    AS scan_status,
  s.quarantine_status              AS quarantine_status,
  s.scan_provider                  AS scan_provider,
  s.signature_version              AS signature_version,
  s.scan_duration_ms               AS scan_duration_ms,
  s.scanned_at::text               AS scanned_at,
  cu.id                            AS cu_id, cu.username AS cu_username, cu.name AS cu_name, cu.surname AS cu_surname,
  au.id                            AS au_id, au.username AS au_username, au.name AS au_name, au.surname AS au_surname
`;

type VersionRow = {
  id: string; document_id: string; version_number: number; status: GedVersionStatus;
  original_name: string; mime_type: string; size_bytes: string; sha256: string;
  change_reason: string | null; created_at: string; submitted_at: string | null;
  approved_at: string | null; published_at: string | null; obsoleted_at: string | null;
  scan_status: GedScanStatus | null; quarantine_status: GedQuarantineStatus | null;
  scan_provider: string | null; signature_version: string | null;
  scan_duration_ms: number | null; scanned_at: string | null;
  cu_id: number | null; cu_username: string | null; cu_name: string | null; cu_surname: string | null;
  au_id: number | null; au_username: string | null; au_name: string | null; au_surname: string | null;
};

function mapVersion(r: VersionRow): GedDocumentVersion {
  return {
    id: r.id,
    document_id: r.document_id,
    version_number: r.version_number,
    status: r.status,
    original_name: r.original_name,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    change_reason: r.change_reason,
    created_at: r.created_at,
    created_by: mapActor({ id: r.cu_id, username: r.cu_username, name: r.cu_name, surname: r.cu_surname }),
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
    approved_by: mapActor({ id: r.au_id, username: r.au_username, name: r.au_name, surname: r.au_surname }),
    published_at: r.published_at,
    obsoleted_at: r.obsoleted_at,
    antivirus: r.scan_status && r.quarantine_status
      ? {
          status: r.scan_status,
          quarantine_status: r.quarantine_status,
          provider: r.scan_provider,
          signature_version: r.signature_version,
          duration_ms: r.scan_duration_ms == null ? null : Number(r.scan_duration_ms),
          scanned_at: r.scanned_at,
          source: "server_upload_scanner",
          freshness_at: r.scanned_at,
          reliability: "MEASURED",
        }
      : {
          status: "legacy_untracked",
          quarantine_status: "legacy_untracked",
          provider: null,
          signature_version: null,
          duration_ms: null,
          scanned_at: null,
          source: "historical_pre_sol_11",
          freshness_at: null,
          reliability: "HISTORICAL_UNVERIFIED",
        },
  };
}

/* -------------------------------------------------------------------------- */
/* Classes documentaires                                                      */
/* -------------------------------------------------------------------------- */

export async function repoListClasses(): Promise<GedDocumentClass[]> {
  try {
    const res = await pool.query(
      `SELECT class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
              max_size_bytes::bigint::text AS max_size_bytes, approvals_required::int AS approvals_required,
              retention_months::int AS retention_months, hold_on_publish, is_active
         FROM public.ged_document_classes
        WHERE is_active
        ORDER BY domain, label`
    );
    return res.rows.map((r) => ({
      class_key: String(r.class_key),
      domain: String(r.domain),
      label: String(r.label),
      nature: r.nature,
      allowed_mime_types: r.allowed_mime_types ?? [],
      allowed_extensions: r.allowed_extensions ?? [],
      max_size_bytes: Number(r.max_size_bytes),
      approvals_required: Number(r.approvals_required),
      retention_months: r.retention_months == null ? null : Number(r.retention_months),
      hold_on_publish: Boolean(r.hold_on_publish),
      is_active: Boolean(r.is_active),
    }));
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetClass(
  classKey: string,
  tx?: Pick<PoolClient, "query">
): Promise<GedDocumentClass | null> {
  const db = tx ?? pool;
  try {
    const res = await db.query(
      `SELECT class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
              max_size_bytes::bigint::text AS max_size_bytes, approvals_required::int AS approvals_required,
              retention_months::int AS retention_months, hold_on_publish, is_active
         FROM public.ged_document_classes
        WHERE class_key = $1 AND is_active`,
      [classKey]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      class_key: String(r.class_key),
      domain: String(r.domain),
      label: String(r.label),
      nature: r.nature,
      allowed_mime_types: r.allowed_mime_types ?? [],
      allowed_extensions: r.allowed_extensions ?? [],
      max_size_bytes: Number(r.max_size_bytes),
      approvals_required: Number(r.approvals_required),
      retention_months: r.retention_months == null ? null : Number(r.retention_months),
      hold_on_publish: Boolean(r.hold_on_publish),
      is_active: Boolean(r.is_active),
    };
  } catch (err) {
    return rethrowGed(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Blobs                                                                      */
/* -------------------------------------------------------------------------- */

const GED_BLOB_LOCK_NAMESPACE = "ged_blob_sha256:";

function assertGedBlobSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new HttpError(500, "GED_BLOB_SHA256", "Empreinte de blob GED invalide.");
  }
}

/**
 * Serialize every filesystem promotion, metadata writer, and compensation for
 * a content-addressed blob. The transaction-scoped lock is intentionally held
 * through COMMIT/ROLLBACK so no cleanup can observe another writer's
 * uncommitted reference and delete the shared durable file underneath it.
 */
export async function repoLockGedBlobSha256(
  tx: Pick<PoolClient, "query">,
  sha256: string
): Promise<void> {
  assertGedBlobSha256(sha256);
  await tx.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`${GED_BLOB_LOCK_NAMESPACE}${sha256}`]
  );
}

export type GedBlobReferenceState = Readonly<{
  blob_present: boolean;
  reference_count: number;
}>;

/** Must be called while holding `repoLockGedBlobSha256` for the same SHA. */
export async function repoGetGedBlobReferenceState(
  tx: Pick<PoolClient, "query">,
  sha256: string
): Promise<GedBlobReferenceState> {
  assertGedBlobSha256(sha256);
  try {
    const res = await tx.query<{ blob_present: boolean; reference_count: string | number }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM public.ged_blobs b WHERE b.sha256 = $1
         ) AS blob_present,
         (
           SELECT COUNT(*)::bigint
             FROM public.ged_document_versions v
             JOIN public.ged_blobs b ON b.id = v.blob_id
            WHERE b.sha256 = $1
         ) AS reference_count`,
      [sha256]
    );
    const row = res.rows[0];
    if (!row) throw new Error("GED blob reference query returned no row");
    const referenceCount = Number(row.reference_count);
    if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) {
      throw new Error("GED blob reference count is invalid");
    }
    return { blob_present: Boolean(row.blob_present), reference_count: referenceCount };
  } catch (err) {
    return rethrowGed(err);
  }
}

/**
 * Run post-rollback filesystem reconciliation under the exact same SHA lock as
 * writers, using a fresh connection and snapshot after the writer transaction
 * has released its lock.
 */
export async function withGedBlobSha256Coordination<T>(
  sha256: string,
  fn: (tx: PoolClient) => Promise<T>
): Promise<T> {
  assertGedBlobSha256(sha256);
  const client = await pool.connect();
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };

  try {
    await client.query("BEGIN");
    await repoLockGedBlobSha256(client, sha256);
  } catch (err) {
    release(true);
    throw err;
  }

  let result: T;
  try {
    result = await fn(client);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
      release();
    } catch {
      release(true);
    }
    throw err;
  }

  try {
    await client.query("ROLLBACK");
    release();
  } catch {
    // This transaction performs no database mutation. The filesystem decision
    // already completed while the lock was held, and destroying the session
    // releases that lock before another writer can proceed. A lost ROLLBACK ACK
    // therefore cannot make the completed cleanup/preserve decision uncertain.
    release(true);
  } finally {
    release();
  }
  return result;
}

export async function repoUpsertBlob(
  tx: Pick<PoolClient, "query">,
  input: { sha256: string; size_bytes: number; mime_type: string; storage_key: string; created_by: number | null }
): Promise<{ id: string }> {
  // Le contenu étant adressé par empreinte, un dépôt identique réutilise le
  // blob existant au lieu d'en créer un second.
  //
  // `DO NOTHING` et non `DO UPDATE` : un blob n'est JAMAIS modifié, et le rôle
  // applicatif ne dispose volontairement que de SELECT et INSERT sur cette table.
  // Un `DO UPDATE`, même sans effet réel, exigerait le privilège UPDATE et
  // échouerait en 42501 — constaté en conditions réelles le 2026-07-28.
  const inserted = await tx.query(
    `INSERT INTO public.ged_blobs (sha256, size_bytes, mime_type, storage_key, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING id::text AS id`,
    [input.sha256, input.size_bytes, input.mime_type, input.storage_key, input.created_by]
  );
  if (inserted.rows[0]) return { id: String(inserted.rows[0].id) };

  // Conflit : le contenu existe déjà, on réutilise son identité.
  const existing = await tx.query(
    `SELECT id::text AS id FROM public.ged_blobs WHERE sha256 = $1`,
    [input.sha256]
  );
  if (!existing.rows[0]) {
    throw new HttpError(500, "GED_BLOB_LOOKUP", "Blob introuvable après conflit d'insertion.");
  }
  return { id: String(existing.rows[0].id) };
}

/* -------------------------------------------------------------------------- */
/* Documents et versions                                                      */
/* -------------------------------------------------------------------------- */

async function nextDocumentCode(tx: Pick<PoolClient, "query">, domain: string): Promise<string> {
  const prefix = formatDocumentCode(domain, 1).split("-")[0];

  // Verrou consultatif de transaction, porté par le préfixe de domaine : deux
  // dépôts simultanés dans le même domaine ne peuvent pas produire le même code.
  //
  // `FOR UPDATE` serait le réflexe, mais PostgreSQL l'interdit avec une fonction
  // d'agrégat — constaté en conditions réelles le 2026-07-28. Le verrou consultatif
  // sérialise la génération sans verrouiller de ligne.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ged_code:${prefix}`]);

  const res = await tx.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '^[A-Z]+-', ''), '')::bigint), 0) + 1 AS next
       FROM public.ged_documents
      WHERE code LIKE $1 || '-%'`,
    [prefix]
  );
  return formatDocumentCode(domain, Number(res.rows[0].next));
}

export async function repoCreateDocumentWithVersion(
  tx: Pick<PoolClient, "query">,
  input: {
    class_key: string;
    domain: string;
    title: string;
    description: string | null;
    blob_id: string;
    original_name: string;
    change_reason: string | null;
    created_by: number | null;
    upload_session_id?: string | null;
  }
): Promise<{ document_id: string; version_id: string; code: string }> {
  const code = await nextDocumentCode(tx, input.domain);

  const docRes = await tx.query(
    `INSERT INTO public.ged_documents (code, class_key, title, description, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text AS id`,
    [code, input.class_key, input.title.trim(), input.description, input.created_by]
  );
  const documentId = String(docRes.rows[0].id);

  const verRes = await tx.query(
    `INSERT INTO public.ged_document_versions
       (document_id, version_number, status, blob_id, original_name, change_reason, created_by, upload_session_id)
     VALUES ($1::uuid, 1, 'BROUILLON', $2::uuid, $3, $4, $5, $6::uuid)
     RETURNING id::text AS id`,
    [documentId, input.blob_id, input.original_name, input.change_reason, input.created_by, input.upload_session_id ?? null]
  );
  const versionId = String(verRes.rows[0].id);

  await tx.query(
    `UPDATE public.ged_documents SET current_version_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
    [documentId, versionId]
  );

  return { document_id: documentId, version_id: versionId, code };
}

export async function repoAddVersion(
  tx: Pick<PoolClient, "query">,
  input: {
    document_id: string;
    blob_id: string;
    original_name: string;
    change_reason: string | null;
    created_by: number | null;
    upload_session_id?: string | null;
  }
): Promise<{ version_id: string; version_number: number }> {
  const nextRes = await tx.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
       FROM public.ged_document_versions WHERE document_id = $1::uuid`,
    [input.document_id]
  );
  const versionNumber = Number(nextRes.rows[0].next);

  const res = await tx.query(
    `INSERT INTO public.ged_document_versions
       (document_id, version_number, status, blob_id, original_name, change_reason, created_by, upload_session_id)
     VALUES ($1::uuid, $2, 'BROUILLON', $3::uuid, $4, $5, $6, $7::uuid)
     RETURNING id::text AS id`,
    [
      input.document_id,
      versionNumber,
      input.blob_id,
      input.original_name,
      input.change_reason,
      input.created_by,
      input.upload_session_id ?? null,
    ]
  );

  await tx.query(`UPDATE public.ged_documents SET updated_at = now() WHERE id = $1::uuid`, [input.document_id]);
  return { version_id: String(res.rows[0].id), version_number: versionNumber };
}

export async function repoGetVersionForUpdate(
  tx: Pick<PoolClient, "query">,
  versionId: string
): Promise<{
  id: string; document_id: string; status: GedVersionStatus; created_by: number | null; version_number: number;
} | null> {
  const res = await tx.query(
    `SELECT id::text AS id, document_id::text AS document_id, status::text AS status,
            created_by, version_number::int AS version_number
       FROM public.ged_document_versions
      WHERE id = $1::uuid
      FOR UPDATE`,
    [versionId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    document_id: String(r.document_id),
    status: r.status as GedVersionStatus,
    created_by: r.created_by == null ? null : Number(r.created_by),
    version_number: Number(r.version_number),
  };
}

export async function repoSetVersionStatus(
  tx: Pick<PoolClient, "query">,
  versionId: string,
  status: GedVersionStatus,
  actorId: number | null
): Promise<void> {
  const stamps: Record<string, string> = {
    EN_REVUE: "submitted_at = now(), submitted_by = $3",
    APPROUVE: "approved_at = now(), approved_by = $3",
    APPLICABLE: "published_at = now()",
    OBSOLETE: "obsoleted_at = now()",
  };
  const extra = stamps[status];
  const sql = `UPDATE public.ged_document_versions SET status = $2${extra ? `, ${extra}` : ""} WHERE id = $1::uuid`;
  const params: unknown[] = [versionId, status];
  if (extra && extra.includes("$3")) params.push(actorId);
  await tx.query(sql, params);
}

/** Bascule l'ancienne version applicable en OBSOLETE, dans la même transaction. */
export async function repoObsoletePreviousApplicable(
  tx: Pick<PoolClient, "query">,
  documentId: string,
  exceptVersionId: string
): Promise<void> {
  await tx.query(
    `UPDATE public.ged_document_versions
        SET status = 'OBSOLETE', obsoleted_at = now()
      WHERE document_id = $1::uuid AND status = 'APPLICABLE' AND id <> $2::uuid`,
    [documentId, exceptVersionId]
  );
}

export async function repoSetCurrentVersion(
  tx: Pick<PoolClient, "query">,
  documentId: string,
  versionId: string
): Promise<void> {
  await tx.query(
    `UPDATE public.ged_documents SET current_version_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
    [documentId, versionId]
  );
}

export async function repoInsertApproval(
  tx: Pick<PoolClient, "query">,
  input: { version_id: string; decision: "SUBMITTED" | "APPROVED" | "REJECTED"; comment: string | null; decided_by: number | null }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.ged_approvals (version_id, decision, comment, decided_by)
     VALUES ($1::uuid, $2, $3, $4)`,
    [input.version_id, input.decision, input.comment, input.decided_by]
  );
}

/* -------------------------------------------------------------------------- */
/* Liens                                                                      */
/* -------------------------------------------------------------------------- */

export async function repoAddLink(
  tx: Pick<PoolClient, "query">,
  input: { document_id: string; entity_type: string; entity_id: string; link_role: string | null; created_by: number | null }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.ged_document_links (document_id, entity_type, entity_id, link_role, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5)
     ON CONFLICT (document_id, entity_type, entity_id, link_role) DO NOTHING`,
    [input.document_id, input.entity_type, input.entity_id, input.link_role, input.created_by]
  );
}

/* -------------------------------------------------------------------------- */
/* Journal d'accès                                                            */
/* -------------------------------------------------------------------------- */

export type GedUploadSessionInternal = GedQuarantineItem & {
  status: "OPEN" | "QUARANTINE" | "READY" | "PUBLISHED" | "EXPIRED" | "REJECTED";
  mime_type: string | null;
  quarantine_key: string | null;
  request_metadata: Record<string, unknown> | null;
  document_id: string | null;
  reject_reason: string | null;
};

export async function repoCreateUploadSession(
  tx: Pick<PoolClient, "query">,
  input: {
    id: string;
    class_key: string;
    document_id: string | null;
    title: string | null;
    sha256: string;
    size_bytes: number;
    mime_type: string;
    original_name: string;
    request_metadata: Record<string, unknown>;
    quarantine_key: string;
    created_by: number;
  }
): Promise<{ id: string }> {
  try {
    const result = await tx.query(
      `INSERT INTO public.ged_upload_sessions
         (id, class_key, document_id, title, status, sha256, size_bytes, mime_type,
          original_name, scan_status, quarantine_status, scan_attempts,
          quarantine_key, request_metadata, created_by, expires_at)
       VALUES
         ($1::uuid, $2, $3::uuid, $4, 'QUARANTINE', $5, $6, $7,
          $8, 'pending', 'quarantined', 0, $9, $10::jsonb, $11, now() + interval '7 days')
       RETURNING id::text AS id`,
      [
        input.id,
        input.class_key,
        input.document_id,
        input.title,
        input.sha256,
        input.size_bytes,
        input.mime_type,
        input.original_name,
        input.quarantine_key,
        JSON.stringify(input.request_metadata),
        input.created_by,
      ]
    );
    return { id: String(result.rows[0].id) };
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoRecordUploadScan(
  db: Pick<PoolClient, "query">,
  input: {
    session_id: string;
    status: "QUARANTINE" | "READY" | "REJECTED";
    scan_status: GedScanStatus;
    quarantine_status: GedQuarantineStatus;
    scan_provider: string;
    signature_version: string | null;
    scan_duration_ms: number;
    quarantine_key: string | null;
    reject_reason: string | null;
  }
): Promise<void> {
  try {
    const result = await db.query(
      `UPDATE public.ged_upload_sessions
          SET status = $2, scan_status = $3, quarantine_status = $4,
              scan_provider = $5, signature_version = $6, scan_duration_ms = $7,
              scan_attempts = scan_attempts + 1, scanned_at = now(),
              quarantine_key = $8, reject_reason = $9, updated_at = now()
        WHERE id = $1::uuid AND status <> 'PUBLISHED'`,
      [
        input.session_id,
        input.status,
        input.scan_status,
        input.quarantine_status,
        input.scan_provider,
        input.signature_version,
        input.scan_duration_ms,
        input.quarantine_key,
        input.reject_reason,
      ]
    );
    if (result.rowCount !== 1) {
      throw new HttpError(409, "GED_QUARANTINE_STATE", "La session de quarantaine n'est plus modifiable.");
    }
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoFinalizeUploadSession(
  tx: Pick<PoolClient, "query">,
  sessionId: string,
  documentId: string,
  clearQuarantineKey = true
): Promise<void> {
  const result = await tx.query(
    `UPDATE public.ged_upload_sessions
        SET status = 'PUBLISHED', document_id = $2::uuid,
            quarantine_status = 'released',
            quarantine_key = CASE WHEN $3::boolean THEN NULL ELSE quarantine_key END,
            reject_reason = NULL, updated_at = now()
      WHERE id = $1::uuid AND scan_status = 'clean'
        AND status IN ('READY', 'QUARANTINE')`,
    [sessionId, documentId, clearQuarantineKey]
  );
  if (result.rowCount !== 1) {
    throw new HttpError(409, "GED_SCAN_REQUIRED", "Le document ne peut pas être publié sans verdict antivirus sain.");
  }
}

function mapQuarantineRow(row: Record<string, unknown>): GedUploadSessionInternal {
  return {
    id: String(row.id),
    class_key: String(row.class_key),
    title: (row.title as string | null) ?? null,
    original_name: (row.original_name as string | null) ?? null,
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: (row.sha256 as string | null) ?? null,
    scan_status: row.scan_status as GedScanStatus,
    quarantine_status: row.quarantine_status as GedQuarantineStatus,
    scan_provider: (row.scan_provider as string | null) ?? null,
    signature_version: (row.signature_version as string | null) ?? null,
    scan_duration_ms: row.scan_duration_ms == null ? null : Number(row.scan_duration_ms),
    scan_attempts: Number(row.scan_attempts ?? 0),
    scanned_at: (row.scanned_at as string | null) ?? null,
    created_at: String(row.created_at),
    created_by: mapActor({
      id: row.u_id == null ? null : Number(row.u_id),
      username: (row.u_username as string | null) ?? null,
      name: (row.u_name as string | null) ?? null,
      surname: (row.u_surname as string | null) ?? null,
    }),
    status: row.status as GedUploadSessionInternal["status"],
    mime_type: (row.mime_type as string | null) ?? null,
    quarantine_key: (row.quarantine_key as string | null) ?? null,
    request_metadata: (row.request_metadata as Record<string, unknown> | null) ?? null,
    document_id: (row.document_id as string | null) ?? null,
    reject_reason: (row.reject_reason as string | null) ?? null,
  };
}

const QUARANTINE_SELECT = `
  s.id::text AS id, s.class_key, s.document_id::text AS document_id, s.title,
  s.status, s.original_name, s.size_bytes::bigint::text AS size_bytes,
  s.mime_type, s.sha256, s.scan_status, s.quarantine_status,
  s.scan_provider, s.signature_version, s.scan_duration_ms, s.scan_attempts,
  s.scanned_at::text AS scanned_at, s.created_at::text AS created_at,
  s.quarantine_key, s.request_metadata, s.reject_reason,
  u.id AS u_id, u.username AS u_username, u.name AS u_name, u.surname AS u_surname
`;

export async function repoListQuarantine(): Promise<GedUploadSessionInternal[]> {
  try {
    const result = await pool.query(
      `SELECT ${QUARANTINE_SELECT}
         FROM public.ged_upload_sessions s
         LEFT JOIN public.users u ON u.id = s.created_by
        WHERE s.quarantine_status = 'quarantined'
        ORDER BY s.created_at ASC
        LIMIT 250`
    );
    return result.rows.map(mapQuarantineRow);
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetQuarantineSessionForUpdate(
  tx: Pick<PoolClient, "query">,
  sessionId: string
): Promise<GedUploadSessionInternal | null> {
  try {
    const result = await tx.query(
      `SELECT ${QUARANTINE_SELECT}
         FROM public.ged_upload_sessions s
         LEFT JOIN public.users u ON u.id = s.created_by
        WHERE s.id = $1::uuid
        FOR UPDATE OF s`,
      [sessionId]
    );
    return result.rows[0] ? mapQuarantineRow(result.rows[0]) : null;
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetQuarantineSession(sessionId: string): Promise<GedUploadSessionInternal | null> {
  try {
    const result = await pool.query(
      `SELECT ${QUARANTINE_SELECT}
         FROM public.ged_upload_sessions s
         LEFT JOIN public.users u ON u.id = s.created_by
        WHERE s.id = $1::uuid`,
      [sessionId]
    );
    return result.rows[0] ? mapQuarantineRow(result.rows[0]) : null;
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoMarkQuarantineDeleted(
  tx: Pick<PoolClient, "query">,
  sessionId: string,
  reason: string
): Promise<void> {
  const result = await tx.query(
    `UPDATE public.ged_upload_sessions
        SET status = 'REJECTED', quarantine_status = 'deleted',
            reject_reason = $2, updated_at = now()
      WHERE id = $1::uuid AND quarantine_status = 'quarantined'`,
    [sessionId, reason]
  );
  if (result.rowCount !== 1) {
    throw new HttpError(409, "GED_QUARANTINE_STATE", "Le fichier n'est plus en quarantaine.");
  }
}


export async function repoClearQuarantineKey(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE public.ged_upload_sessions
        SET quarantine_key = NULL, updated_at = now()
      WHERE id = $1::uuid AND quarantine_status IN ('deleted', 'released')`,
    [sessionId]
  );
}

export async function repoLogAccess(
  db: Pick<PoolClient, "query">,
  input: {
    document_id: string | null;
    version_id: string | null;
    event_type: string;
    actor_id: number | null;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  // `details` ne doit contenir ni chemin, ni secret, ni contenu binaire.
  await db.query(
    `INSERT INTO public.ged_access_events (document_id, version_id, event_type, actor_id, details)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
    [
      input.document_id,
      input.version_id,
      input.event_type,
      input.actor_id,
      input.details ? JSON.stringify(input.details) : null,
    ]
  );
}

export async function repoListAccessEvents(documentId: string, limit = 100): Promise<GedAccessEvent[]> {
  try {
    const res = await pool.query(
      `SELECT e.id::text AS id, e.event_type, e.occurred_at::text AS occurred_at, e.details,
              u.id AS u_id, u.username AS u_username, u.name AS u_name, u.surname AS u_surname
         FROM public.ged_access_events e
         LEFT JOIN public.users u ON u.id = e.actor_id
        WHERE e.document_id = $1::uuid
        ORDER BY e.occurred_at DESC
        LIMIT $2`,
      [documentId, limit]
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      event_type: String(r.event_type),
      actor: mapActor({ id: r.u_id, username: r.u_username, name: r.u_name, surname: r.u_surname }),
      occurred_at: String(r.occurred_at),
      details: r.details ?? null,
    }));
  } catch (err) {
    return rethrowGed(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

const SUMMARY_SELECT = `
  d.id::text AS id, d.code, d.class_key, c.label AS class_label, c.domain,
  d.title, d.description,
  cv.version_number::int AS current_version_number,
  cv.status::text        AS current_version_status,
  (SELECT COUNT(*) FROM public.ged_document_versions vv WHERE vv.document_id = d.id)::int AS versions_count,
  EXISTS (SELECT 1 FROM public.ged_retention_holds h WHERE h.document_id = d.id AND h.released_at IS NULL) AS has_active_hold,
  d.created_at::text AS created_at, d.updated_at::text AS updated_at, d.archived_at::text AS archived_at
`;

function mapSummary(r: Record<string, unknown>): GedDocumentSummary {
  return {
    id: String(r.id),
    code: String(r.code),
    class_key: String(r.class_key),
    class_label: String(r.class_label),
    domain: String(r.domain),
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    current_version_number: r.current_version_number == null ? null : Number(r.current_version_number),
    current_version_status: (r.current_version_status as GedVersionStatus | null) ?? null,
    versions_count: Number(r.versions_count ?? 0),
    has_active_hold: Boolean(r.has_active_hold),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    archived_at: (r.archived_at as string | null) ?? null,
  };
}

export async function repoListDocuments(filters: GedListFilters): Promise<GedListResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (value: unknown) => `$${params.push(value)}`;

  if (!filters.include_archived) where.push("d.archived_at IS NULL");
  if (filters.class_key) where.push(`d.class_key = ${push(filters.class_key)}`);
  if (filters.domain) where.push(`c.domain = ${push(filters.domain)}`);
  if (filters.status) where.push(`cv.status = ${push(filters.status)}`);
  if (filters.q) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push(`(lower(d.title) LIKE ${push(like)} OR lower(d.code) LIKE ${push(like)})`);
  }
  if (filters.entity_type && filters.entity_id) {
    where.push(
      `EXISTS (SELECT 1 FROM public.ged_document_links l
                WHERE l.document_id = d.id AND l.entity_type = ${push(filters.entity_type)}
                  AND l.entity_id = ${push(filters.entity_id)})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `
    FROM public.ged_documents d
    JOIN public.ged_document_classes c ON c.class_key = d.class_key
    LEFT JOIN public.ged_document_versions cv ON cv.id = d.current_version_id
  `;

  try {
    const countRes = await pool.query(`SELECT COUNT(*)::int AS total ${from} ${whereSql}`, params);
    const total = Number(countRes.rows[0]?.total ?? 0);

    const offset = (filters.page - 1) * filters.page_size;
    const rowsRes = await pool.query(
      `SELECT ${SUMMARY_SELECT} ${from} ${whereSql}
        ORDER BY d.updated_at DESC
        LIMIT ${push(filters.page_size)} OFFSET ${push(offset)}`,
      params
    );

    return {
      items: rowsRes.rows.map(mapSummary),
      total,
      page: filters.page,
      page_size: filters.page_size,
    };
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetDocumentDetail(documentId: string): Promise<GedDocumentDetail | null> {
  try {
    const docRes = await pool.query(
      `SELECT ${SUMMARY_SELECT}
         FROM public.ged_documents d
         JOIN public.ged_document_classes c ON c.class_key = d.class_key
         LEFT JOIN public.ged_document_versions cv ON cv.id = d.current_version_id
        WHERE d.id = $1::uuid`,
      [documentId]
    );
    const docRow = docRes.rows[0];
    if (!docRow) return null;

    const versionsRes = await pool.query<VersionRow>(
      `SELECT ${VERSION_SELECT}
         FROM public.ged_document_versions v
         JOIN public.ged_blobs b ON b.id = v.blob_id
         LEFT JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
         LEFT JOIN public.users cu ON cu.id = v.created_by
         LEFT JOIN public.users au ON au.id = v.approved_by
        WHERE v.document_id = $1::uuid
        ORDER BY v.version_number DESC`,
      [documentId]
    );
    const versions = versionsRes.rows.map(mapVersion);

    const linksRes = await pool.query(
      `SELECT id::text AS id, entity_type, entity_id, link_role, created_at::text AS created_at
         FROM public.ged_document_links WHERE document_id = $1::uuid ORDER BY created_at`,
      [documentId]
    );
    const links: GedDocumentLink[] = linksRes.rows.map((r) => ({
      id: String(r.id),
      entity_type: String(r.entity_type),
      entity_id: String(r.entity_id),
      link_role: (r.link_role as string | null) ?? null,
      created_at: String(r.created_at),
    }));

    const holdsRes = await pool.query(
      `SELECT id::text AS id, hold_type, reason, placed_at::text AS placed_at, released_at::text AS released_at
         FROM public.ged_retention_holds WHERE document_id = $1::uuid ORDER BY placed_at DESC`,
      [documentId]
    );
    const holds: GedRetentionHold[] = holdsRes.rows.map((r) => ({
      id: String(r.id),
      hold_type: r.hold_type,
      reason: String(r.reason),
      placed_at: String(r.placed_at),
      released_at: (r.released_at as string | null) ?? null,
    }));

    const checkoutRes = await pool.query(
      `SELECT k.id::text AS id, k.reason, k.checked_out_at::text AS checked_out_at, k.expires_at::text AS expires_at,
              u.id AS u_id, u.username AS u_username, u.name AS u_name, u.surname AS u_surname
         FROM public.ged_checkouts k
         LEFT JOIN public.users u ON u.id = k.held_by
        WHERE k.document_id = $1::uuid AND k.released_at IS NULL
        LIMIT 1`,
      [documentId]
    );
    const ck = checkoutRes.rows[0];

    const currentVersionId = versions.find((v) => v.status === "APPLICABLE")?.id ?? null;

    return {
      ...mapSummary(docRow),
      current_version: currentVersionId
        ? versions.find((v) => v.id === currentVersionId) ?? null
        : versions[0] ?? null,
      versions,
      links,
      holds,
      active_checkout: ck
        ? {
            id: String(ck.id),
            held_by: mapActor({ id: ck.u_id, username: ck.u_username, name: ck.u_name, surname: ck.u_surname }),
            reason: String(ck.reason),
            checked_out_at: String(ck.checked_out_at),
            expires_at: String(ck.expires_at),
          }
        : null,
    };
  } catch (err) {
    return rethrowGed(err);
  }
}

/**
 * INTERNE : remonte la clé de stockage pour le téléchargement.
 * Le retour de cette fonction ne doit JAMAIS être sérialisé vers un client.
 */
export async function repoInternalGetVersionContentRef(versionId: string): Promise<{
  version_id: string;
  document_id: string;
  status: GedVersionStatus;
  original_name: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  scan_status: GedScanStatus | null;
  quarantine_status: GedQuarantineStatus | null;
} | null> {
  try {
    const res = await pool.query(
      `SELECT v.id::text AS version_id, v.document_id::text AS document_id, v.status::text AS status,
              v.original_name, b.mime_type, b.sha256, b.size_bytes, b.storage_key,
              s.scan_status, s.quarantine_status
         FROM public.ged_document_versions v
         JOIN public.ged_blobs b ON b.id = v.blob_id
         LEFT JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
        WHERE v.id = $1::uuid`,
      [versionId]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      version_id: String(r.version_id),
      document_id: String(r.document_id),
      status: r.status as GedVersionStatus,
      original_name: String(r.original_name),
      mime_type: String(r.mime_type),
      sha256: String(r.sha256),
      size_bytes: Number(r.size_bytes),
      storage_key: String(r.storage_key),
      scan_status: (r.scan_status as GedScanStatus | null) ?? null,
      quarantine_status: (r.quarantine_status as GedQuarantineStatus | null) ?? null,
    };
  } catch (err) {
    return rethrowGed(err);
  }
}

/**
 * Internal-only parent binding lookup used at the byte-delivery boundary.
 * A GED document is deliberately not downloadable merely because a user has
 * the global GED capability: its single business parent must be known and
 * live. Unknown historical link vocabularies are resolved by the service as
 * an opaque denial so this query must never be exposed through a controller.
 */
export async function repoInternalListDocumentParentLinks(documentId: string): Promise<Array<{
  entity_type: string;
  entity_id: string;
}>> {
  try {
    const result = await pool.query<{ entity_type: string; entity_id: string }>(
      `SELECT entity_type, entity_id
         FROM public.ged_document_links
        WHERE document_id = $1::uuid
        ORDER BY created_at ASC, id ASC`,
      [documentId]
    );
    return result.rows.map((row) => ({ entity_type: String(row.entity_type), entity_id: String(row.entity_id) }));
  } catch (err) {
    return rethrowGed(err);
  }
}

/** Closed, non-dynamic parent existence registry for byte authorization. */
export async function repoInternalParentLinkExists(entityType: string, entityId: string): Promise<boolean> {
  const key = entityType.trim().toUpperCase();
  const statements: Record<string, { sql: string; values: unknown[] }> = {
    CLIENT: { sql: "SELECT 1 FROM public.clients WHERE client_id = $1 LIMIT 1", values: [entityId] },
    FOURNISSEUR: { sql: "SELECT 1 FROM public.fournisseurs WHERE id = $1::uuid LIMIT 1", values: [entityId] },
    DEVIS: { sql: "SELECT 1 FROM public.devis WHERE id = $1::bigint LIMIT 1", values: [entityId] },
    FACTURE: { sql: "SELECT 1 FROM public.facture WHERE id = $1 LIMIT 1", values: [entityId] },
    AVOIR: { sql: "SELECT 1 FROM public.avoir WHERE id = $1 LIMIT 1", values: [entityId] },
    BON_LIVRAISON: { sql: "SELECT 1 FROM public.bon_livraison WHERE id = $1::uuid LIMIT 1", values: [entityId] },
    COMMANDE_CLIENT: { sql: "SELECT 1 FROM public.commande_client WHERE id = $1::bigint LIMIT 1", values: [entityId] },
    COMMANDE_FOURNISSEUR: { sql: "SELECT 1 FROM public.commande_fournisseur WHERE id = $1::uuid LIMIT 1", values: [entityId] },
    AFFAIRE: { sql: "SELECT 1 FROM public.affaire WHERE id = $1::bigint LIMIT 1", values: [entityId] },
    ORDRE_FABRICATION: { sql: "SELECT 1 FROM public.ordres_fabrication WHERE id = $1::bigint LIMIT 1", values: [entityId] },
    PIECE_TECHNIQUE: { sql: "SELECT 1 FROM public.pieces_techniques WHERE id = $1::uuid LIMIT 1", values: [entityId] },
    PIECE_TECHNIQUE_VERSION: { sql: "SELECT 1 FROM public.piece_technique_versions WHERE id = $1::uuid LIMIT 1", values: [entityId] },
    STOCK_ARTICLE: { sql: "SELECT 1 FROM public.articles WHERE id = $1::bigint LIMIT 1", values: [entityId] },
    OUTIL: { sql: "SELECT 1 FROM public.gestion_outils_outil WHERE id_outil = $1::integer LIMIT 1", values: [entityId] },
  };
  const statement = statements[key];
  if (!statement) return false;
  try {
    const result = await pool.query(statement.sql, statement.values);
    return result.rowCount !== 0;
  } catch (err) {
    return rethrowGed(err);
  }
}

/** Fresh-connection reconciliation used only after a COMMIT acknowledgement loss. */
export async function repoIsVersionBlobCommitted(
  versionId: string,
  sha256: string
): Promise<UploadCommitReconciliation> {
  try {
    const res = await pool.query<{ version_sha256: string | null; blob_present: boolean }>(
      `SELECT
         (SELECT b.sha256
            FROM public.ged_document_versions v
            JOIN public.ged_blobs b ON b.id = v.blob_id
           WHERE v.id = $1::uuid) AS version_sha256,
         EXISTS (
           SELECT 1 FROM public.ged_blobs b WHERE b.sha256 = $2
         ) AS blob_present`,
      [versionId, sha256]
    );
    const row = res.rows[0];
    if (row?.version_sha256 === sha256) return "committed";
    if (row?.version_sha256 || row?.blob_present) return "uncertain";
    return "not-committed";
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetTree(): Promise<{ domain: string; class_key: string; class_label: string; documents_count: number }[]> {
  try {
    const res = await pool.query(
      `SELECT c.domain, c.class_key, c.label AS class_label,
              COUNT(d.id)::int AS documents_count
         FROM public.ged_document_classes c
         LEFT JOIN public.ged_documents d ON d.class_key = c.class_key AND d.archived_at IS NULL
        WHERE c.is_active
        GROUP BY c.domain, c.class_key, c.label
        ORDER BY c.domain, c.label`
    );
    return res.rows.map((r) => ({
      domain: String(r.domain),
      class_key: String(r.class_key),
      class_label: String(r.class_label),
      documents_count: Number(r.documents_count),
    }));
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoFindDocumentByBlobHash(
  tx: Pick<PoolClient, "query">,
  sha256: string
): Promise<{ document_id: string; code: string } | null> {
  const res = await tx.query(
    `SELECT d.id::text AS document_id, d.code
       FROM public.ged_blobs b
       JOIN public.ged_document_versions v ON v.blob_id = b.id
       JOIN public.ged_documents d ON d.id = v.document_id
      WHERE b.sha256 = $1 AND d.archived_at IS NULL
      LIMIT 1`,
    [sha256]
  );
  const r = res.rows[0];
  return r ? { document_id: String(r.document_id), code: String(r.code) } : null;
}
