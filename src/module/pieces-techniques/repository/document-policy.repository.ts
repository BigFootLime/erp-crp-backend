// src/module/pieces-techniques/repository/document-policy.repository.ts
// Issue #227 — accès base de la politique documentaire Client → Pièce technique.
//
// Le dépôt ne DÉCIDE rien : il lit le référentiel, la politique du client, l'état de la
// pièce et les documents déposés, puis écrit l'instantané gelé. Toute la règle vit dans
// src/module/pieces-techniques/domain/document-policy.ts.
import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import {
  normalizeClientDocumentPolicy,
  type AttachedDocument,
  type ClientDocumentPolicy,
  type DocumentRequirement,
  type PieceDocumentType,
} from "../domain/document-policy";
import type { AuditContext } from "./pieces-techniques.repository";

type Queryer = Pick<PoolClient, "query">;

async function insertAudit(
  tx: Queryer,
  audit: AuditContext,
  entry: { action: string; entity_type: string | null; entity_id: string | null; details?: Record<string, unknown> | null }
): Promise<void> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

/**
 * Une base sans le patch #227 ne doit pas briquer le module Données techniques : le code
 * de la pièce, sa gamme et sa nomenclature restent parfaitement utilisables sans exigence
 * documentaire. On détecte l'absence d'infrastructure et on retombe sur « aucune
 * exigence » — un comportement sûr, jamais une obligation inventée.
 */
export class DocumentPolicyInfrastructureMissing extends Error {
  constructor(public readonly relation: string) {
    super(`#227: relation ${relation} absente — patch 20260729_piece_technique_document_policy_227.sql non appliqué`);
    this.name = "DocumentPolicyInfrastructureMissing";
  }
}

function isMissingRelation(err: unknown): boolean {
  // 42P01 undefined_table, 42703 undefined_column : le patch n'est pas passé sur cette base.
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

export async function repoDocumentPolicyInfrastructureReady(tx: Queryer = db): Promise<boolean> {
  const res = await tx.query<{ ready: boolean }>(
    `SELECT (to_regclass('public.piece_document_types') IS NOT NULL
             AND to_regclass('public.client_document_requirements') IS NOT NULL
             AND to_regclass('public.piece_version_document_requirements') IS NOT NULL) AS ready`
  );
  return res.rows[0]?.ready === true;
}

/* -------------------------------------------------------------------------- */
/* Référentiel des types                                                      */
/* -------------------------------------------------------------------------- */

type DocumentTypeRow = {
  code: string;
  label: string;
  description: string | null;
  ged_class_key: string | null;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
};

export type PieceDocumentTypeRecord = PieceDocumentType & { is_system: boolean; description: string | null };

const DOCUMENT_TYPE_COLUMNS = `
  code, label, description, ged_class_key, is_system, is_active, sort_order::int AS sort_order
`;

function mapDocumentType(row: DocumentTypeRow): PieceDocumentTypeRecord {
  return {
    code: row.code,
    label: row.label,
    description: row.description,
    ged_class_key: row.ged_class_key,
    is_system: row.is_system,
    is_active: row.is_active,
    sort_order: row.sort_order,
  };
}

export async function repoListDocumentTypes(
  options: { includeInactive?: boolean } = {},
  tx: Queryer = db
): Promise<PieceDocumentTypeRecord[]> {
  try {
    const res = await tx.query<DocumentTypeRow>(
      `SELECT ${DOCUMENT_TYPE_COLUMNS}
         FROM public.piece_document_types
        WHERE ($1::boolean IS TRUE OR is_active)
        ORDER BY sort_order ASC, code ASC`,
      [options.includeInactive === true]
    );
    return res.rows.map(mapDocumentType);
  } catch (err) {
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.piece_document_types");
    throw err;
  }
}

export type UpsertDocumentTypeInput = {
  code: string;
  label: string;
  description?: string | null;
  ged_class_key?: string | null;
  is_active?: boolean;
  sort_order?: number;
};

export async function repoCreateDocumentType(
  input: UpsertDocumentTypeInput,
  audit: AuditContext
): Promise<PieceDocumentTypeRecord> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ code: string }>(
      `SELECT code FROM public.piece_document_types WHERE code = $1`,
      [input.code]
    );
    if (existing.rows[0]) {
      throw new HttpError(409, "DOCUMENT_TYPE_EXISTS", `Le type de document ${input.code} existe déjà.`);
    }
    const res = await client.query<DocumentTypeRow>(
      `INSERT INTO public.piece_document_types
         (code, label, description, ged_class_key, is_system, is_active, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, false, COALESCE($5, true), COALESCE($6, 100), $7, $7)
       RETURNING ${DOCUMENT_TYPE_COLUMNS}`,
      [
        input.code,
        input.label,
        input.description ?? null,
        input.ged_class_key ?? null,
        input.is_active ?? null,
        input.sort_order ?? null,
        audit.user_id,
      ]
    );
    await insertAudit(client, audit, {
      action: "pieces-techniques.document-type.create",
      entity_type: "piece_document_types",
      entity_id: input.code,
      details: { label: input.label },
    });
    await client.query("COMMIT");
    return mapDocumentType(res.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.piece_document_types");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateDocumentType(
  code: string,
  patch: Partial<Omit<UpsertDocumentTypeInput, "code">>,
  audit: AuditContext
): Promise<PieceDocumentTypeRecord | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ is_system: boolean }>(
      `SELECT is_system FROM public.piece_document_types WHERE code = $1 FOR UPDATE`,
      [code]
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    // Un type fondateur peut être renommé ou réordonné, jamais désactivé : la politique
    // documentaire d'un client peut déjà s'appuyer dessus et le gel garde sa trace.
    if (row.is_system && patch.is_active === false) {
      throw new HttpError(
        409,
        "DOCUMENT_TYPE_SYSTEM_LOCKED",
        "Un type de document fondateur ne peut pas être désactivé. Retirez-le de la sélection des clients concernés."
      );
    }
    const res = await client.query<DocumentTypeRow>(
      `UPDATE public.piece_document_types
          SET label         = COALESCE($2, label),
              description   = COALESCE($3, description),
              ged_class_key = COALESCE($4, ged_class_key),
              is_active     = COALESCE($5, is_active),
              sort_order    = COALESCE($6, sort_order),
              updated_at    = now(),
              updated_by    = $7
        WHERE code = $1
        RETURNING ${DOCUMENT_TYPE_COLUMNS}`,
      [
        code,
        patch.label ?? null,
        patch.description ?? null,
        patch.ged_class_key ?? null,
        patch.is_active ?? null,
        patch.sort_order ?? null,
        audit.user_id,
      ]
    );
    await insertAudit(client, audit, {
      action: "pieces-techniques.document-type.update",
      entity_type: "piece_document_types",
      entity_id: code,
      details: { ...patch },
    });
    await client.query("COMMIT");
    return mapDocumentType(res.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.piece_document_types");
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Politique d'un client                                                      */
/* -------------------------------------------------------------------------- */

export type ClientDocumentPolicyRecord = {
  client_id: string;
  company_name: string | null;
  policy: ClientDocumentPolicy;
  selected_type_codes: string[];
  updated_at: string | null;
  updated_by: number | null;
};

export async function repoGetClientDocumentPolicy(
  clientId: string,
  tx: Queryer = db
): Promise<ClientDocumentPolicyRecord | null> {
  try {
    const res = await tx.query<{
      client_id: string;
      company_name: string | null;
      document_policy: string | null;
      document_policy_updated_at: string | null;
      document_policy_updated_by: number | null;
      selected: string[] | null;
    }>(
      `SELECT c.client_id,
              c.company_name,
              c.document_policy,
              c.document_policy_updated_at::text AS document_policy_updated_at,
              c.document_policy_updated_by,
              COALESCE(
                ARRAY(
                  SELECT r.document_type_code
                    FROM public.client_document_requirements r
                   WHERE r.client_id = c.client_id
                   ORDER BY r.document_type_code
                ),
                '{}'
              ) AS selected
         FROM public.clients c
        WHERE c.client_id = $1`,
      [clientId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      client_id: row.client_id,
      company_name: row.company_name,
      policy: normalizeClientDocumentPolicy(row.document_policy),
      selected_type_codes: row.selected ?? [],
      updated_at: row.document_policy_updated_at,
      updated_by: row.document_policy_updated_by,
    };
  } catch (err) {
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.client_document_requirements");
    throw err;
  }
}

export async function repoSetClientDocumentPolicy(
  clientId: string,
  input: { policy: ClientDocumentPolicy; selected_type_codes: string[] },
  audit: AuditContext
): Promise<ClientDocumentPolicyRecord | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.clients WHERE client_id = $1 FOR UPDATE`,
      [clientId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    if (input.selected_type_codes.length > 0) {
      const known = await client.query<{ code: string }>(
        `SELECT code FROM public.piece_document_types WHERE code = ANY($1::text[])`,
        [input.selected_type_codes]
      );
      const knownCodes = new Set(known.rows.map((r) => r.code));
      const unknown = input.selected_type_codes.filter((c) => !knownCodes.has(c));
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          "UNKNOWN_DOCUMENT_TYPE",
          `Type(s) de document inconnu(s) : ${unknown.join(", ")}.`
        );
      }
    }

    await client.query(
      `UPDATE public.clients
          SET document_policy            = $2,
              document_policy_updated_at = now(),
              document_policy_updated_by = $3
        WHERE client_id = $1`,
      [clientId, input.policy, audit.user_id]
    );

    // Remplacement de la sélection : on retire ce qui n'est plus retenu, on ajoute le
    // reste. Aucune donnée de PIÈCE n'est touchée — seule la préférence du client change,
    // et les versions déjà gelées gardent leur instantané.
    await client.query(
      `DELETE FROM public.client_document_requirements
        WHERE client_id = $1
          AND NOT (document_type_code = ANY($2::text[]))`,
      [clientId, input.selected_type_codes]
    );
    if (input.selected_type_codes.length > 0) {
      await client.query(
        `INSERT INTO public.client_document_requirements (client_id, document_type_code, created_by)
         SELECT $1, code, $3 FROM unnest($2::text[]) AS code
         ON CONFLICT (client_id, document_type_code) DO NOTHING`,
        [clientId, input.selected_type_codes, audit.user_id]
      );
    }

    await insertAudit(client, audit, {
      action: "pieces-techniques.document-policy.set",
      entity_type: "clients",
      entity_id: clientId,
      details: { policy: input.policy, selected_type_codes: input.selected_type_codes },
    });

    await client.query("COMMIT");
    return repoGetClientDocumentPolicy(clientId);
  } catch (err) {
    await client.query("ROLLBACK");
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.client_document_requirements");
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Contexte documentaire d'une pièce                                          */
/* -------------------------------------------------------------------------- */

export type PieceDocumentContext = {
  piece_technique_id: string;
  code_piece: string;
  designation: string;
  client_id: string | null;
  client_name: string | null;
  piece_critique: boolean;
  piece_critique_motif: string | null;
  policy: ClientDocumentPolicy;
  selected_type_codes: string[];
  current_version_id: string | null;
  current_version_indice: string | null;
  current_version_statut: string | null;
  frozen_at: string | null;
  frozen_policy: ClientDocumentPolicy | null;
  documents: AttachedDocument[];
};

export async function repoGetPieceDocumentContext(
  pieceTechniqueId: string,
  tx: Queryer = db
): Promise<PieceDocumentContext | null> {
  try {
    const res = await tx.query<{
      piece_technique_id: string;
      code_piece: string;
      designation: string;
      client_id: string | null;
      client_name: string | null;
      piece_critique: boolean | null;
      piece_critique_motif: string | null;
      document_policy: string | null;
      selected: string[] | null;
      current_version_id: string | null;
      current_version_indice: string | null;
      current_version_statut: string | null;
      frozen_at: string | null;
      frozen_policy: string | null;
    }>(
      `SELECT p.id::text                       AS piece_technique_id,
              p.code_piece,
              p.designation,
              p.client_id,
              p.client_name,
              p.piece_critique,
              p.piece_critique_motif,
              c.document_policy,
              COALESCE(
                ARRAY(
                  SELECT r.document_type_code
                    FROM public.client_document_requirements r
                   WHERE r.client_id = p.client_id
                   ORDER BY r.document_type_code
                ),
                '{}'
              )                                AS selected,
              v.id::text                       AS current_version_id,
              v.indice                         AS current_version_indice,
              v.statut::text                   AS current_version_statut,
              v.document_requirements_frozen_at::text AS frozen_at,
              v.document_requirements_policy   AS frozen_policy
         FROM public.pieces_techniques p
         LEFT JOIN public.clients c ON c.client_id = p.client_id
         LEFT JOIN LATERAL (
              SELECT pv.id, pv.indice, pv.statut,
                     pv.document_requirements_frozen_at, pv.document_requirements_policy
                FROM public.piece_technique_versions pv
               WHERE pv.piece_technique_id = p.id
               ORDER BY pv.is_current DESC,
                        CASE pv.statut WHEN 'APPLICABLE' THEN 0 WHEN 'EN_VALIDATION' THEN 1 WHEN 'BROUILLON' THEN 2 ELSE 3 END,
                        pv.created_at DESC
               LIMIT 1
         ) v ON true
        WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
      [pieceTechniqueId]
    );
    const row = res.rows[0];
    if (!row) return null;

    const docs = await tx.query<{
      id: string;
      original_name: string;
      mime_type: string | null;
      size_bytes: string | null;
      document_type_code: string | null;
      piece_technique_version_id: string | null;
      created_at: string | null;
      removed_at: string | null;
    }>(
      `SELECT id::text AS id, original_name, mime_type, size_bytes::text AS size_bytes,
              document_type_code, piece_technique_version_id::text AS piece_technique_version_id,
              created_at::text AS created_at, removed_at::text AS removed_at
         FROM public.pieces_techniques_documents
        WHERE piece_technique_id = $1::uuid AND removed_at IS NULL
        ORDER BY created_at DESC`,
      [pieceTechniqueId]
    );

    return {
      piece_technique_id: row.piece_technique_id,
      code_piece: row.code_piece,
      designation: row.designation,
      client_id: row.client_id,
      client_name: row.client_name,
      piece_critique: row.piece_critique === true,
      piece_critique_motif: row.piece_critique_motif,
      policy: normalizeClientDocumentPolicy(row.document_policy),
      selected_type_codes: row.selected ?? [],
      current_version_id: row.current_version_id,
      current_version_indice: row.current_version_indice,
      current_version_statut: row.current_version_statut,
      frozen_at: row.frozen_at,
      frozen_policy: row.frozen_policy ? normalizeClientDocumentPolicy(row.frozen_policy) : null,
      documents: docs.rows.map((d) => ({
        id: d.id,
        original_name: d.original_name,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes === null ? null : Number(d.size_bytes),
        document_type_code: d.document_type_code,
        piece_technique_version_id: d.piece_technique_version_id,
        created_at: d.created_at,
        removed_at: d.removed_at,
      })),
    };
  } catch (err) {
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.piece_document_types");
    throw err;
  }
}

/** Marque une pièce comme critique (ou non) — n'a d'effet que sous PER_PT_CRITICAL. */
export async function repoSetPieceCritique(
  pieceTechniqueId: string,
  input: { piece_critique: boolean; motif?: string | null },
  audit: AuditContext
): Promise<{ piece_critique: boolean; piece_critique_motif: string | null } | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ piece_critique: boolean; piece_critique_motif: string | null }>(
      `UPDATE public.pieces_techniques
          SET piece_critique       = $2,
              piece_critique_motif = $3,
              updated_at           = now(),
              updated_by           = $4
        WHERE id = $1::uuid AND deleted_at IS NULL
        RETURNING piece_critique, piece_critique_motif`,
      [pieceTechniqueId, input.piece_critique, input.motif ?? null, audit.user_id]
    );
    const row = res.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await insertAudit(client, audit, {
      action: "pieces-techniques.piece-critique.set",
      entity_type: "pieces_techniques",
      entity_id: pieceTechniqueId,
      details: { piece_critique: input.piece_critique, motif: input.motif ?? null },
    });
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.pieces_techniques.piece_critique");
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Gel des exigences sur une version                                          */
/* -------------------------------------------------------------------------- */

export type FrozenRequirementRow = {
  document_type_code: string;
  document_type_label: string;
  policy: ClientDocumentPolicy;
  piece_critique: boolean;
  reason_code: string;
  reason_label: string;
  frozen_at: string;
};

export async function repoListFrozenRequirements(
  versionId: string,
  tx: Queryer = db
): Promise<FrozenRequirementRow[]> {
  try {
    const res = await tx.query<FrozenRequirementRow>(
      `SELECT document_type_code, document_type_label, policy, piece_critique,
              reason_code, reason_label, frozen_at::text AS frozen_at
         FROM public.piece_version_document_requirements
        WHERE piece_technique_version_id = $1::uuid
        ORDER BY document_type_code`,
      [versionId]
    );
    return res.rows;
  } catch (err) {
    if (isMissingRelation(err)) throw new DocumentPolicyInfrastructureMissing("public.piece_version_document_requirements");
    throw err;
  }
}

/**
 * Fige les exigences sur une version. Idempotent par construction : si la version porte
 * déjà un gel, on ne le réécrit PAS — c'est exactement la garantie demandée, « une
 * modification ultérieure du client ne doit pas modifier silencieusement une version
 * existante ». Renvoie `already_frozen: true` dans ce cas.
 */
export async function repoFreezeVersionRequirements(
  tx: Queryer,
  params: {
    versionId: string;
    policy: ClientDocumentPolicy;
    pieceCritique: boolean;
    requirements: readonly DocumentRequirement[];
    userId: number | null;
  }
): Promise<{ already_frozen: boolean; frozen_count: number }> {
  const current = await tx.query<{ frozen_at: string | null }>(
    `SELECT document_requirements_frozen_at::text AS frozen_at
       FROM public.piece_technique_versions
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.versionId]
  );
  const row = current.rows[0];
  if (!row) throw new HttpError(404, "VERSION_NOT_FOUND", "Version introuvable");
  if (row.frozen_at) {
    const existing = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.piece_version_document_requirements
        WHERE piece_technique_version_id = $1::uuid`,
      [params.versionId]
    );
    return { already_frozen: true, frozen_count: Number(existing.rows[0]?.n ?? "0") };
  }

  for (const requirement of params.requirements) {
    await tx.query(
      `INSERT INTO public.piece_version_document_requirements
         (piece_technique_version_id, document_type_code, document_type_label,
          policy, piece_critique, reason_code, reason_label, frozen_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (piece_technique_version_id, document_type_code) DO NOTHING`,
      [
        params.versionId,
        requirement.document_type_code,
        requirement.document_type_label,
        params.policy,
        params.pieceCritique,
        requirement.reason_code,
        requirement.reason_label,
        params.userId,
      ]
    );
  }

  await tx.query(
    `UPDATE public.piece_technique_versions
        SET document_requirements_frozen_at = now(),
            document_requirements_policy    = $2
      WHERE id = $1::uuid`,
    [params.versionId, params.policy]
  );

  return { already_frozen: false, frozen_count: params.requirements.length };
}

export { isMissingRelation as isDocumentPolicyRelationMissing };
