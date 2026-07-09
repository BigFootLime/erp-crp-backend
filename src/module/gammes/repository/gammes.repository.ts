// src/module/gammes/repository/gammes.repository.ts
// GPAO B2.2 — repository des gammes + opérations de gamme.
import type { PoolClient } from "pg"
import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import type {
  AddGammeOperationBodyDTO,
  CreateGammeBodyDTO,
  GammeStatutDTO,
  OperationTypeDTO,
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

export type GammeOperationRow = {
  id: string
  piece_technique_id: string
  gamme_id: string | null
  ordre: number | null
  phase: number | null
  designation: string
  designation_2: string | null
  type_operation: OperationTypeDTO | null
  machine_id: string | null
  poste_id: string | null
  cf_id: string | null
  tp: number | null
  tf_unit: number | null
  qte: number | null
  coef: number | null
  taux_horaire: number | null
  prix: number | null
  temps_total: number | null
  cout_mo: number | null
  consignes: string | null
}

const GAMME_COLS = `
  id::text AS id, piece_technique_version_id::text AS piece_technique_version_id, nom, code, designation,
  commentaire, statut, is_current, created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by
`
const OP_COLS = `
  id::text AS id, piece_technique_id::text AS piece_technique_id, gamme_id::text AS gamme_id, ordre, phase,
  designation, designation_2, type_operation, machine_id::text AS machine_id, poste_id::text AS poste_id,
  cf_id::text AS cf_id, tp::float8 AS tp, tf_unit::float8 AS tf_unit, qte::float8 AS qte, coef::float8 AS coef,
  taux_horaire::float8 AS taux_horaire, prix::float8 AS prix, temps_total::float8 AS temps_total,
  cout_mo::float8 AS cout_mo, consignes
`

function computeOperation(input: { tp: number; tf_unit: number; qte: number; coef: number; taux_horaire: number }) {
  const round = (v: number, d: number) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : 0)
  const tempsTotal = round((input.tp + input.tf_unit * input.qte) * input.coef, 3)
  const coutMo = round(tempsTotal * input.taux_horaire, 2)
  return { temps_total: tempsTotal, cout_mo: coutMo }
}

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

export async function repoListGammeOperations(gammeId: string): Promise<GammeOperationRow[]> {
  const gamme = await db.query(`SELECT 1 FROM public.gammes WHERE id = $1`, [gammeId])
  if (gamme.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
  const res = await db.query<GammeOperationRow>(
    `SELECT ${OP_COLS} FROM public.pieces_techniques_operations
     WHERE gamme_id = $1 ORDER BY ordre NULLS LAST, phase NULLS LAST, id`,
    [gammeId]
  )
  return res.rows
}

export async function repoAddGammeOperation(
  gammeId: string,
  body: AddGammeOperationBodyDTO,
  audit: AuditContext
): Promise<GammeOperationRow> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    // gamme -> version -> pièce (piece_technique_id NOT NULL sur la table opérations)
    const link = await client.query<{ piece_technique_id: string }>(
      `SELECT ptv.piece_technique_id::text AS piece_technique_id
       FROM public.gammes g JOIN public.piece_technique_versions ptv ON ptv.id = g.piece_technique_version_id
       WHERE g.id = $1`,
      [gammeId]
    )
    if (link.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {})
      throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    }
    const pieceTechniqueId = link.rows[0].piece_technique_id

    const nextOrdre = await client.query<{ next_ordre: number }>(
      `SELECT COALESCE(MAX(ordre), 0) + 10 AS next_ordre FROM public.pieces_techniques_operations WHERE gamme_id = $1`,
      [gammeId]
    )
    const ordre = nextOrdre.rows[0]?.next_ordre ?? 10

    const tp = body.temps_preparation ?? 0
    const tfUnit = body.temps_cycle ?? 0
    const qte = body.qte ?? 1
    const coef = body.coef ?? 1
    const tauxHoraire = body.taux_horaire ?? 0
    const { temps_total, cout_mo } = computeOperation({ tp, tf_unit: tfUnit, qte, coef, taux_horaire: tauxHoraire })

    const res = await client.query<GammeOperationRow>(
      `INSERT INTO public.pieces_techniques_operations
        (piece_technique_id, gamme_id, ordre, phase, designation, designation_2, type_operation, machine_id,
         poste_id, cf_id, tp, tf_unit, qte, coef, taux_horaire, prix, temps_total, cout_mo, consignes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING ${OP_COLS}`,
      [
        pieceTechniqueId,
        gammeId,
        ordre,
        body.numero_operation ?? 10,
        body.designation,
        body.designation_2 ?? null,
        body.type_operation ?? null,
        body.machine_id ?? null,
        body.poste_id ?? null,
        body.cf_id ?? null,
        tp,
        tfUnit,
        qte,
        coef,
        tauxHoraire,
        body.prix ?? 0,
        temps_total,
        cout_mo,
        body.consignes ?? null,
      ]
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "gammes.operations.add", "gamme_operation", row.id, {
      gamme_id: gammeId,
      type_operation: row.type_operation,
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

// Réordonne via `ordre` — NE TOUCHE PAS à `phase` (numéro d'opération métier).
export async function repoReorderGammeOperations(gammeId: string, order: string[], audit: AuditContext): Promise<GammeOperationRow[]> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const gamme = await client.query(`SELECT 1 FROM public.gammes WHERE id = $1 FOR UPDATE`, [gammeId])
    if (gamme.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {})
      throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    }
    for (let i = 0; i < order.length; i += 1) {
      await client.query(
        `UPDATE public.pieces_techniques_operations SET ordre = $1, updated_at = now() WHERE id = $2 AND gamme_id = $3`,
        [(i + 1) * 10, order[i], gammeId]
      )
    }
    await insertAudit(client, audit, "gammes.operations.reorder", "gamme", gammeId, { count: order.length })
    const res = await client.query<GammeOperationRow>(
      `SELECT ${OP_COLS} FROM public.pieces_techniques_operations WHERE gamme_id = $1 ORDER BY ordre NULLS LAST, phase NULLS LAST, id`,
      [gammeId]
    )
    await client.query("COMMIT")
    return res.rows
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
