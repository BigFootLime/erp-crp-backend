// src/module/gammes/repository/gammes.repository.ts
// GPAO B2.2 — repository de l'ENTÊTE de gamme (identité, statut, gamme courante).
// Les OPÉRATIONS vivent dans `gamme-operations.repository.ts` : elles portent la
// numérotation des phases, les référentiels Méthodes, le calcul des temps et le
// gel du tarif, qui n'ont rien à faire dans la gestion de l'entête.
import type { PoolClient } from "pg"
import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import type {
  CreateGammeBodyDTO,
  GammeStatutDTO,
  UpdateGammeBodyDTO,
} from "../validators/gammes.validators"

export type GammeRow = {
  id: string
  piece_technique_version_id: string
  nom: string | null
  code: string | null
  designation: string | null
  commentaire: string | null
  statut: GammeStatutDTO
  is_current: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

const GAMME_COLS = `
  id::text AS id, piece_technique_version_id::text AS piece_technique_version_id, nom, code, designation,
  commentaire, statut, is_current, created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by
`
async function insertAudit(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> | null
) {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key,
      entity_type: entityType,
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

async function assertVersionExists(tx: Pick<PoolClient, "query">, versionId: string): Promise<void> {
  const res = await tx.query(`SELECT 1 FROM public.piece_technique_versions WHERE id = $1`, [versionId])
  if (res.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Version introuvable")
}

export async function repoListGammesByVersion(versionId: string): Promise<GammeRow[]> {
  await assertVersionExists(db, versionId)
  const res = await db.query<GammeRow>(
    `SELECT ${GAMME_COLS} FROM public.gammes WHERE piece_technique_version_id = $1 ORDER BY is_current DESC, created_at ASC`,
    [versionId]
  )
  return res.rows
}

export async function repoCreateGamme(versionId: string, body: CreateGammeBodyDTO, audit: AuditContext): Promise<GammeRow> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await assertVersionExists(client, versionId)
    // une seule gamme courante par version
    if (body.is_current) {
      await client.query(
        `UPDATE public.gammes SET is_current = false, updated_at = now(), updated_by = $2
         WHERE piece_technique_version_id = $1 AND is_current = true`,
        [versionId, audit.user_id]
      )
    }
    const res = await client.query<GammeRow>(
      `INSERT INTO public.gammes
        (piece_technique_version_id, nom, code, designation, commentaire, statut, is_current, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       RETURNING ${GAMME_COLS}`,
      [
        versionId,
        body.nom,
        body.code ?? null,
        body.designation ?? null,
        body.commentaire ?? null,
        body.statut ?? "BROUILLON",
        body.is_current ?? false,
        audit.user_id,
      ]
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "gammes.create", "gamme", row.id, {
      piece_technique_version_id: versionId,
      nom: row.nom,
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

export async function repoUpdateGamme(gammeId: string, body: UpdateGammeBodyDTO, audit: AuditContext): Promise<GammeRow | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const cur = await client.query<{ piece_technique_version_id: string; updated_at: string }>(
      `SELECT piece_technique_version_id::text AS piece_technique_version_id, updated_at::text AS updated_at
       FROM public.gammes WHERE id = $1 FOR UPDATE`,
      [gammeId]
    )
    const current = cur.rows[0]
    if (!current) {
      await client.query("ROLLBACK").catch(() => {})
      return null
    }
    if (body.expected_updated_at && body.expected_updated_at !== current.updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La gamme a été modifiée entre-temps")
    }
    if (body.is_current === true) {
      await client.query(
        `UPDATE public.gammes SET is_current = false, updated_at = now(), updated_by = $3
         WHERE piece_technique_version_id = $1 AND is_current = true AND id <> $2`,
        [current.piece_technique_version_id, gammeId, audit.user_id]
      )
    }

    const sets: string[] = []
    const values: unknown[] = []
    const push = (col: string, val: unknown) => {
      values.push(val)
      sets.push(`${col} = $${values.length}`)
    }
    if (body.nom !== undefined) push("nom", body.nom)
    if (body.code !== undefined) push("code", body.code)
    if (body.designation !== undefined) push("designation", body.designation)
    if (body.commentaire !== undefined) push("commentaire", body.commentaire)
    if (body.statut !== undefined) push("statut", body.statut)
    if (body.is_current !== undefined) push("is_current", body.is_current)
    values.push(audit.user_id)
    sets.push(`updated_by = $${values.length}`)
    sets.push(`updated_at = now()`)
    values.push(gammeId)

    const res = await client.query<GammeRow>(
      `UPDATE public.gammes SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${GAMME_COLS}`,
      values
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "gammes.update", "gamme", gammeId, null)
    await client.query("COMMIT")
    return row
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
