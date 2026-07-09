// src/module/pieces-techniques/repository/versions.repository.ts
// GPAO B2.1 — repository des versions/indices d'une pièce technique.
import type { PoolClient } from "pg"
import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { AuditContext } from "./pieces-techniques.repository"
import type {
  CreateNextVersionBodyDTO,
  CreateVersionBodyDTO,
  UpdateVersionBodyDTO,
  VersionStatutDTO,
} from "../validators/versions.validators"

export type PieceTechniqueVersionRow = {
  id: string
  piece_technique_id: string
  indice: string
  plan_reference: string | null
  matiere_prevue: string | null
  statut: VersionStatutDTO
  is_current: boolean
  commentaire_revision: string | null
  type_changement: "EVOLUTION" | "MODIFICATION" | null
  raison_changement: string | null
  impact_interchangeabilite: boolean | null
  impact_parents: string | null
  valide_par: number | null
  date_validation: string | null
  date_application: string | null
  commentaire_validation: string | null
  date_revision: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

const VERSION_COLUMNS = `
  id::text AS id, piece_technique_id::text AS piece_technique_id, indice, plan_reference, matiere_prevue,
  statut, is_current, commentaire_revision, type_changement, raison_changement, impact_interchangeabilite,
  impact_parents, valide_par, date_validation::text AS date_validation, date_application::text AS date_application,
  commentaire_validation, date_revision::text AS date_revision, created_at::text AS created_at,
  updated_at::text AS updated_at, created_by, updated_by
`

async function insertAudit(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  action: string,
  entityId: string,
  details: Record<string, unknown> | null
) {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key,
      entity_type: "piece_technique_version",
      entity_id: entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  })
}

async function assertPieceExists(tx: Pick<PoolClient, "query">, pieceId: string): Promise<void> {
  const res = await tx.query(`SELECT 1 FROM public.pieces_techniques WHERE id = $1 AND deleted_at IS NULL`, [pieceId])
  if (res.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Pièce technique introuvable")
}

export async function repoListVersions(pieceTechniqueId: string): Promise<PieceTechniqueVersionRow[]> {
  await assertPieceExists(db, pieceTechniqueId)
  const res = await db.query<PieceTechniqueVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM public.piece_technique_versions
     WHERE piece_technique_id = $1
     ORDER BY created_at ASC, indice ASC`,
    [pieceTechniqueId]
  )
  return res.rows
}

export async function repoGetVersion(pieceTechniqueId: string, versionId: string): Promise<PieceTechniqueVersionRow | null> {
  const res = await db.query<PieceTechniqueVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM public.piece_technique_versions WHERE id = $1 AND piece_technique_id = $2`,
    [versionId, pieceTechniqueId]
  )
  return res.rows[0] ?? null
}

export async function repoCreateVersion(
  pieceTechniqueId: string,
  body: CreateVersionBodyDTO,
  audit: AuditContext
): Promise<PieceTechniqueVersionRow> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await assertPieceExists(client, pieceTechniqueId)

    const res = await client.query<PieceTechniqueVersionRow>(
      `INSERT INTO public.piece_technique_versions
        (piece_technique_id, indice, plan_reference, matiere_prevue, statut, is_current,
         commentaire_revision, type_changement, raison_changement, impact_interchangeabilite, impact_parents,
         date_revision, created_by, updated_by)
       VALUES ($1,$2,$3,$4,'BROUILLON',false,$5,$6,$7,$8,$9, now(), $10,$10)
       RETURNING ${VERSION_COLUMNS}`,
      [
        pieceTechniqueId,
        body.indice,
        body.plan_reference ?? null,
        body.matiere_prevue ?? null,
        body.commentaire_revision ?? null,
        body.type_changement ?? null,
        body.raison_changement ?? null,
        body.impact_interchangeabilite ?? null,
        body.impact_parents ?? null,
        audit.user_id,
      ]
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "pieces-techniques.version.create", row.id, {
      piece_technique_id: pieceTechniqueId,
      indice: row.indice,
    })
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    // unique (piece_technique_id, indice)
    if ((e as { code?: string })?.code === "23505") {
      throw new HttpError(409, "CONFLICT", "Cet indice existe déjà pour cette pièce")
    }
    throw e
  } finally {
    client.release()
  }
}

// Édition autorisée uniquement en BROUILLON / EN_VALIDATION (une version APPLICABLE ne se
// modifie pas directement — on crée une nouvelle version).
export async function repoUpdateVersion(
  pieceTechniqueId: string,
  versionId: string,
  body: UpdateVersionBodyDTO,
  audit: AuditContext
): Promise<PieceTechniqueVersionRow | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const cur = await client.query<{ statut: VersionStatutDTO; updated_at: string }>(
      `SELECT statut, updated_at::text AS updated_at FROM public.piece_technique_versions
       WHERE id = $1 AND piece_technique_id = $2 FOR UPDATE`,
      [versionId, pieceTechniqueId]
    )
    const current = cur.rows[0]
    if (!current) {
      await client.query("ROLLBACK").catch(() => {})
      return null
    }
    if (current.statut === "APPLICABLE" || current.statut === "OBSOLETE") {
      throw new HttpError(409, "VERSION_LOCKED", "Une version applicable/obsolète ne se modifie pas — créez une nouvelle version")
    }
    if (body.expected_updated_at && body.expected_updated_at !== current.updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La version a été modifiée entre-temps")
    }

    const sets: string[] = []
    const values: unknown[] = []
    const push = (col: string, val: unknown) => {
      values.push(val)
      sets.push(`${col} = $${values.length}`)
    }
    if (body.indice !== undefined) push("indice", body.indice)
    if (body.plan_reference !== undefined) push("plan_reference", body.plan_reference)
    if (body.matiere_prevue !== undefined) push("matiere_prevue", body.matiere_prevue)
    if (body.commentaire_revision !== undefined) push("commentaire_revision", body.commentaire_revision)
    if (body.type_changement !== undefined) push("type_changement", body.type_changement)
    if (body.raison_changement !== undefined) push("raison_changement", body.raison_changement)
    if (body.impact_interchangeabilite !== undefined) push("impact_interchangeabilite", body.impact_interchangeabilite)
    if (body.impact_parents !== undefined) push("impact_parents", body.impact_parents)

    values.push(audit.user_id)
    sets.push(`updated_by = $${values.length}`)
    sets.push(`updated_at = now()`)

    values.push(versionId)
    const res = await client.query<PieceTechniqueVersionRow>(
      `UPDATE public.piece_technique_versions SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${VERSION_COLUMNS}`,
      values
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "pieces-techniques.version.update", versionId, { piece_technique_id: pieceTechniqueId })
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    if ((e as { code?: string })?.code === "23505") throw new HttpError(409, "CONFLICT", "Cet indice existe déjà pour cette pièce")
    throw e
  } finally {
    client.release()
  }
}

// Transition de statut. Passe à APPLICABLE = déclasse l'APPLICABLE précédente en OBSOLETE
// (règle : une seule version APPLICABLE par pièce) dans la même transaction.
export async function repoUpdateVersionStatus(
  pieceTechniqueId: string,
  versionId: string,
  toStatut: VersionStatutDTO,
  extra: { valide_par: number | null; date_application: string | null; commentaire_validation: string | null; expected_updated_at?: string },
  audit: AuditContext
): Promise<PieceTechniqueVersionRow | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const cur = await client.query<{ statut: VersionStatutDTO; updated_at: string }>(
      `SELECT statut, updated_at::text AS updated_at FROM public.piece_technique_versions
       WHERE id = $1 AND piece_technique_id = $2 FOR UPDATE`,
      [versionId, pieceTechniqueId]
    )
    const current = cur.rows[0]
    if (!current) {
      await client.query("ROLLBACK").catch(() => {})
      return null
    }
    if (extra.expected_updated_at && extra.expected_updated_at !== current.updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La version a été modifiée entre-temps")
    }

    // Passe APPLICABLE : déclasser l'ancienne APPLICABLE d'abord (respecte l'index unique partiel).
    if (toStatut === "APPLICABLE") {
      await client.query(
        `UPDATE public.piece_technique_versions
         SET statut = 'OBSOLETE', is_current = false, updated_at = now(), updated_by = $3
         WHERE piece_technique_id = $1 AND statut = 'APPLICABLE' AND id <> $2`,
        [pieceTechniqueId, versionId, audit.user_id]
      )
    }

    const isCurrent = toStatut === "APPLICABLE"
    const res = await client.query<PieceTechniqueVersionRow>(
      `UPDATE public.piece_technique_versions SET
         statut = $2,
         is_current = $3,
         valide_par = CASE WHEN $2 = 'APPLICABLE' THEN $4 ELSE valide_par END,
         date_validation = CASE WHEN $2 = 'APPLICABLE' THEN now() ELSE date_validation END,
         date_application = CASE WHEN $2 = 'APPLICABLE' THEN COALESCE($5::date, date_application, CURRENT_DATE) ELSE date_application END,
         commentaire_validation = COALESCE($6, commentaire_validation),
         updated_at = now(), updated_by = $7
       WHERE id = $1
       RETURNING ${VERSION_COLUMNS}`,
      [versionId, toStatut, isCurrent, extra.valide_par ?? audit.user_id, extra.date_application ?? null, extra.commentaire_validation ?? null, audit.user_id]
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "pieces-techniques.version.status", versionId, {
      piece_technique_id: pieceTechniqueId,
      from: current.statut,
      to: toStatut,
    })
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// "Créer une nouvelle version depuis une version existante" (Nouvel indice / évolution / modification).
export async function repoCreateNextVersion(
  pieceTechniqueId: string,
  sourceVersionId: string,
  body: CreateNextVersionBodyDTO,
  audit: AuditContext
): Promise<PieceTechniqueVersionRow> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const src = await client.query<{ id: string; plan_reference: string | null; matiere_prevue: string | null }>(
      `SELECT id::text AS id, plan_reference, matiere_prevue FROM public.piece_technique_versions
       WHERE id = $1 AND piece_technique_id = $2`,
      [sourceVersionId, pieceTechniqueId]
    )
    if (src.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {})
      throw new HttpError(404, "NOT_FOUND", "Version source introuvable")
    }
    const source = src.rows[0]

    const res = await client.query<PieceTechniqueVersionRow>(
      `INSERT INTO public.piece_technique_versions
        (piece_technique_id, indice, plan_reference, matiere_prevue, statut, is_current,
         commentaire_revision, type_changement, raison_changement, impact_interchangeabilite, impact_parents,
         date_revision, created_by, updated_by)
       VALUES ($1,$2,$3,$4,'BROUILLON',false,$5,$6,$7,$8,$9, now(), $10,$10)
       RETURNING ${VERSION_COLUMNS}`,
      [
        pieceTechniqueId,
        body.indice,
        body.plan_reference ?? source.plan_reference,
        body.matiere_prevue ?? source.matiere_prevue,
        body.commentaire_revision ?? null,
        body.type_changement ?? null,
        body.raison_changement ?? null,
        body.impact_interchangeabilite ?? null,
        body.impact_parents ?? null,
        audit.user_id,
      ]
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "pieces-techniques.version.create-next", row.id, {
      piece_technique_id: pieceTechniqueId,
      source_version_id: sourceVersionId,
      indice: row.indice,
      type_changement: row.type_changement,
    })
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    if ((e as { code?: string })?.code === "23505") throw new HttpError(409, "CONFLICT", "Cet indice existe déjà pour cette pièce")
    throw e
  } finally {
    client.release()
  }
}
