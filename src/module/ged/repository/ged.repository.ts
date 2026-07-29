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
import { HttpError } from "../../../utils/httpError";
import {
  formatDocumentCode,
  type GedCapability,
  type GedVersionStatus,
} from "../domain/ged-policy";
import type {
  GedAccessScope,
  GedAccessEvent,
  GedDocumentClass,
  GedDocumentDetail,
  GedDocumentLink,
  GedDocumentSummary,
  GedDocumentVersion,
  GedListFilters,
  GedListResult,
  GedRetentionHold,
} from "../types/ged.types";

const UNDEFINED_TABLE = "42P01";

export type GedAuthorization = {
  role_keys: readonly string[];
  capability: GedCapability;
  scope?: GedAccessScope | null;
};

function classCapabilityPredicate(
  classExpression: string,
  roleKeysParameter: string,
  capabilityParameter: string
): string {
  return `EXISTS (
    SELECT 1
      FROM public.ged_class_capabilities cap
     WHERE cap.class_key = ${classExpression}
       AND cap.role_key = ANY(${roleKeysParameter}::text[])
       AND cap.capability IN (${capabilityParameter}, 'admin')
  )`;
}

function documentScopePredicate(
  documentExpression: string,
  classExpression: string,
  roleKeysParameter: string,
  scopeTypeParameter: string,
  scopeIdParameter: string
): string {
  return `(
    ${classCapabilityPredicate(classExpression, roleKeysParameter, "'admin'")}
    OR NOT EXISTS (
      SELECT 1 FROM public.ged_document_links scope_any
       WHERE scope_any.document_id = ${documentExpression}
    )
    OR (
      ${scopeTypeParameter}::text IS NOT NULL
      AND ${scopeIdParameter}::text IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.ged_document_links scope_match
         WHERE scope_match.document_id = ${documentExpression}
           AND scope_match.entity_type = ${scopeTypeParameter}
           AND scope_match.entity_id = ${scopeIdParameter}
      )
    )
  )`;
}

export function isGedSchemaMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/** Convertit une table manquante en 503 lisible ; laisse passer le reste. */
function rethrowGed(err: unknown): never {
  if (isGedSchemaMissing(err)) {
    throw new HttpError(
      503,
      "GED_NOT_INSTALLED",
      "Le module GED n'est pas complètement installé sur cette base (patches GED requis)."
    );
  }
  throw err;
}

export async function withGedTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return rethrowGed(err);
  } finally {
    client.release();
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
  cu.id                            AS cu_id, cu.username AS cu_username, cu.name AS cu_name, cu.surname AS cu_surname,
  au.id                            AS au_id, au.username AS au_username, au.name AS au_name, au.surname AS au_surname
`;

type VersionRow = {
  id: string; document_id: string; version_number: number; status: GedVersionStatus;
  original_name: string; mime_type: string; size_bytes: string; sha256: string;
  change_reason: string | null; created_at: string; submitted_at: string | null;
  approved_at: string | null; published_at: string | null; obsoleted_at: string | null;
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
  };
}

/* -------------------------------------------------------------------------- */
/* Classes documentaires                                                      */
/* -------------------------------------------------------------------------- */

export async function repoActorHasAnyCapability(
  roleKeys: readonly string[],
  capability: GedCapability
): Promise<boolean> {
  if (roleKeys.length === 0) return false;
  try {
    const res = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM public.ged_class_capabilities cap
          WHERE cap.role_key = ANY($1::text[])
            AND cap.capability IN ($2, 'admin')
       ) AS granted`,
      [roleKeys, capability]
    );
    return Boolean(res.rows[0]?.granted);
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoActorHasClassCapability(
  classKey: string,
  roleKeys: readonly string[],
  capability: GedCapability,
  tx?: Pick<PoolClient, "query">
): Promise<boolean> {
  if (roleKeys.length === 0) return false;
  const db = tx ?? pool;
  try {
    const res = await db.query(
      `SELECT ${classCapabilityPredicate("$1", "$2", "$3")} AS granted`,
      [classKey, roleKeys, capability]
    );
    return Boolean(res.rows[0]?.granted);
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoListClasses(
  roleKeys: readonly string[],
  capability: GedCapability = "read"
): Promise<GedDocumentClass[]> {
  try {
    const res = await pool.query(
      `SELECT c.class_key, c.domain, c.label, c.nature, c.allowed_mime_types, c.allowed_extensions,
              c.max_size_bytes::bigint::text AS max_size_bytes,
              c.approvals_required::int AS approvals_required,
              c.retention_months::int AS retention_months,
              c.hold_on_publish, c.is_active
         FROM public.ged_document_classes c
        WHERE c.is_active
          AND ${classCapabilityPredicate("c.class_key", "$1", "$2")}
        ORDER BY c.domain, c.label`,
      [roleKeys, capability]
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

export async function repoGetClassForActor(
  classKey: string,
  authorization: GedAuthorization,
  tx?: Pick<PoolClient, "query">
): Promise<GedDocumentClass | null> {
  if (authorization.role_keys.length === 0) return null;
  const granted = await repoActorHasClassCapability(
    classKey,
    authorization.role_keys,
    authorization.capability,
    tx
  );
  if (!granted) return null;
  return repoGetClass(classKey, tx);
}

/* -------------------------------------------------------------------------- */
/* Blobs                                                                      */
/* -------------------------------------------------------------------------- */

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
       (document_id, version_number, status, blob_id, original_name, change_reason, created_by)
     VALUES ($1::uuid, 1, 'BROUILLON', $2::uuid, $3, $4, $5)
     RETURNING id::text AS id`,
    [documentId, input.blob_id, input.original_name, input.change_reason, input.created_by]
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
       (document_id, version_number, status, blob_id, original_name, change_reason, created_by)
     VALUES ($1::uuid, $2, 'BROUILLON', $3::uuid, $4, $5, $6)
     RETURNING id::text AS id`,
    [input.document_id, versionNumber, input.blob_id, input.original_name, input.change_reason, input.created_by]
  );

  await tx.query(`UPDATE public.ged_documents SET updated_at = now() WHERE id = $1::uuid`, [input.document_id]);
  return { version_id: String(res.rows[0].id), version_number: versionNumber };
}

export async function repoGetVersionForUpdate(
  tx: Pick<PoolClient, "query">,
  versionId: string,
  authorization: GedAuthorization
): Promise<{
  id: string; document_id: string; status: GedVersionStatus; created_by: number | null; version_number: number;
} | null> {
  const res = await tx.query(
    `SELECT v.id::text AS id, v.document_id::text AS document_id, v.status::text AS status,
            v.created_by, v.version_number::int AS version_number
       FROM public.ged_document_versions v
       JOIN public.ged_documents d ON d.id = v.document_id
      WHERE v.id = $1::uuid
        AND ${classCapabilityPredicate("d.class_key", "$2", "$3")}
        AND ${documentScopePredicate("d.id", "d.class_key", "$2", "$4", "$5")}
      FOR UPDATE`,
    [
      versionId,
      authorization.role_keys,
      authorization.capability,
      authorization.scope?.entity_type ?? null,
      authorization.scope?.entity_id ?? null,
    ]
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

export async function repoLinkTargetExists(
  entityType: string,
  entityId: string,
  tx?: Pick<PoolClient, "query">
): Promise<boolean> {
  const db = tx ?? pool;
  try {
    if (entityType !== "PIECE_TECHNIQUE_VERSION") return false;
    const res = await db.query(
      `SELECT EXISTS (
         SELECT 1
           FROM public.piece_technique_versions v
          WHERE v.id = $1::uuid
       ) AS found`,
      [entityId]
    );
    return Boolean(res.rows[0]?.found);
  } catch (err) {
    return rethrowGed(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Journal d'accès                                                            */
/* -------------------------------------------------------------------------- */

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

export async function repoListAccessEvents(
  documentId: string,
  authorization: GedAuthorization,
  limit = 100
): Promise<GedAccessEvent[]> {
  try {
    const res = await pool.query(
      `SELECT e.id::text AS id, e.event_type, e.occurred_at::text AS occurred_at, e.details,
              u.id AS u_id, u.username AS u_username, u.name AS u_name, u.surname AS u_surname
         FROM public.ged_access_events e
         JOIN public.ged_documents d ON d.id = e.document_id
         LEFT JOIN public.users u ON u.id = e.actor_id
        WHERE e.document_id = $1::uuid
          AND ${classCapabilityPredicate("d.class_key", "$2", "$3")}
          AND ${documentScopePredicate("d.id", "d.class_key", "$2", "$4", "$5")}
        ORDER BY e.occurred_at DESC
        LIMIT $6`,
      [
        documentId,
        authorization.role_keys,
        authorization.capability,
        authorization.scope?.entity_type ?? null,
        authorization.scope?.entity_id ?? null,
        limit,
      ]
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
  d.created_at::text AS created_at, d.updated_at::text AS updated_at, d.archived_at::text AS archived_at,
  scope.entity_type AS access_scope_entity_type,
  scope.entity_id AS access_scope_entity_id
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
    access_scope:
      r.access_scope_entity_type && r.access_scope_entity_id
        ? {
            entity_type: String(r.access_scope_entity_type),
            entity_id: String(r.access_scope_entity_id),
          }
        : null,
  };
}

export async function repoListDocuments(
  filters: GedListFilters,
  authorization: GedAuthorization
): Promise<GedListResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (value: unknown) => `$${params.push(value)}`;

  const roleKeysParameter = push(authorization.role_keys);
  const capabilityParameter = push(authorization.capability);
  let preferredScopeTypeParameter = "NULL";
  let preferredScopeIdParameter = "NULL";
  where.push(classCapabilityPredicate("d.class_key", roleKeysParameter, capabilityParameter));

  if (!filters.include_archived) where.push("d.archived_at IS NULL");
  if (filters.class_key) where.push(`d.class_key = ${push(filters.class_key)}`);
  if (filters.domain) where.push(`c.domain = ${push(filters.domain)}`);
  if (filters.status) where.push(`cv.status = ${push(filters.status)}`);
  if (filters.q) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    where.push(`(lower(d.title) LIKE ${push(like)} OR lower(d.code) LIKE ${push(like)})`);
  }
  if (filters.entity_type && filters.entity_id) {
    preferredScopeTypeParameter = push(filters.entity_type);
    preferredScopeIdParameter = push(filters.entity_id);
    where.push(
      `EXISTS (SELECT 1 FROM public.ged_document_links l
                WHERE l.document_id = d.id AND l.entity_type = ${preferredScopeTypeParameter}
                  AND l.entity_id = ${preferredScopeIdParameter})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `
    FROM public.ged_documents d
    JOIN public.ged_document_classes c ON c.class_key = d.class_key
    LEFT JOIN public.ged_document_versions cv ON cv.id = d.current_version_id
    LEFT JOIN LATERAL (
      SELECT l.entity_type, l.entity_id
        FROM public.ged_document_links l
       WHERE l.document_id = d.id
       ORDER BY
         (l.entity_type = ${preferredScopeTypeParameter}::text
          AND l.entity_id = ${preferredScopeIdParameter}::text) DESC,
         l.created_at,
         l.id
       LIMIT 1
    ) scope ON true
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

export async function repoGetDocumentDetail(
  documentId: string,
  authorization: GedAuthorization
): Promise<GedDocumentDetail | null> {
  try {
    const docRes = await pool.query(
      `SELECT ${SUMMARY_SELECT}
         FROM public.ged_documents d
         JOIN public.ged_document_classes c ON c.class_key = d.class_key
         LEFT JOIN public.ged_document_versions cv ON cv.id = d.current_version_id
         LEFT JOIN LATERAL (
           SELECT l.entity_type, l.entity_id
             FROM public.ged_document_links l
            WHERE l.document_id = d.id
            ORDER BY
              (l.entity_type = $4::text AND l.entity_id = $5::text) DESC,
              l.created_at,
              l.id
            LIMIT 1
         ) scope ON true
        WHERE d.id = $1::uuid
          AND ${classCapabilityPredicate("d.class_key", "$2", "$3")}
          AND ${documentScopePredicate("d.id", "d.class_key", "$2", "$4", "$5")}`,
      [
        documentId,
        authorization.role_keys,
        authorization.capability,
        authorization.scope?.entity_type ?? null,
        authorization.scope?.entity_id ?? null,
      ]
    );
    const docRow = docRes.rows[0];
    if (!docRow) return null;

    const versionsRes = await pool.query<VersionRow>(
      `SELECT ${VERSION_SELECT}
         FROM public.ged_document_versions v
         JOIN public.ged_blobs b ON b.id = v.blob_id
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
export async function repoInternalGetVersionContentRef(
  versionId: string,
  authorization: GedAuthorization
): Promise<{
  version_id: string;
  document_id: string;
  class_key: string;
  status: GedVersionStatus;
  original_name: string;
  mime_type: string;
  sha256: string;
  storage_key: string;
} | null> {
  try {
    const res = await pool.query(
      `SELECT v.id::text AS version_id, v.document_id::text AS document_id, v.status::text AS status,
              d.class_key, v.original_name, b.mime_type, b.sha256, b.storage_key
         FROM public.ged_document_versions v
         JOIN public.ged_documents d ON d.id = v.document_id
         JOIN public.ged_blobs b ON b.id = v.blob_id
        WHERE v.id = $1::uuid
          AND ${classCapabilityPredicate("d.class_key", "$2", "$3")}
          AND ${documentScopePredicate("d.id", "d.class_key", "$2", "$4", "$5")}`,
      [
        versionId,
        authorization.role_keys,
        authorization.capability,
        authorization.scope?.entity_type ?? null,
        authorization.scope?.entity_id ?? null,
      ]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      version_id: String(r.version_id),
      document_id: String(r.document_id),
      class_key: String(r.class_key),
      status: r.status as GedVersionStatus,
      original_name: String(r.original_name),
      mime_type: String(r.mime_type),
      sha256: String(r.sha256),
      storage_key: String(r.storage_key),
    };
  } catch (err) {
    return rethrowGed(err);
  }
}

export async function repoGetTree(
  authorization: GedAuthorization
): Promise<{ domain: string; class_key: string; class_label: string; documents_count: number }[]> {
  try {
    const res = await pool.query(
      `SELECT c.domain, c.class_key, c.label AS class_label,
              COUNT(d.id)::int AS documents_count
         FROM public.ged_document_classes c
         LEFT JOIN public.ged_documents d ON d.class_key = c.class_key AND d.archived_at IS NULL
        WHERE c.is_active
          AND ${classCapabilityPredicate("c.class_key", "$1", "$2")}
        GROUP BY c.domain, c.class_key, c.label
        ORDER BY c.domain, c.label`,
      [authorization.role_keys, authorization.capability]
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
): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1
       FROM public.ged_blobs b
       JOIN public.ged_document_versions v ON v.blob_id = b.id
       JOIN public.ged_documents d ON d.id = v.document_id
      WHERE b.sha256 = $1 AND d.archived_at IS NULL
      LIMIT 1`,
    [sha256]
  );
  return Boolean(res.rows[0]);
}
