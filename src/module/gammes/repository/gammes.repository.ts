// src/module/gammes/repository/gammes.repository.ts
// GPAO B2.2 — repository de l'ENTÊTE de gamme (identité, statut, gamme courante).
// Les OPÉRATIONS vivent dans `gamme-operations.repository.ts` : elles portent la
// numérotation des phases, les référentiels Méthodes, le calcul des temps et le
// gel du tarif, qui n'ont rien à faire dans la gestion de l'entête.
import type { PoolClient } from "pg"
import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { resolveGammeName } from "../domain/gamme-naming"
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

/**
 * #227 — éléments de nommage automatique d'une gamme : code métier et désignation de la
 * pièce, indice de la version, rang de la gamme sur cet indice. Le nom d'une gamme est
 * une conséquence, pas une opinion : c'est le serveur qui le calcule.
 */
async function readGammeNamingContext(
  tx: Pick<PoolClient, "query">,
  versionId: string
): Promise<{ codePiece: string | null; designation: string | null; indice: string | null; rank: number }> {
  const res = await tx.query<{
    code_piece: string | null
    designation: string | null
    indice: string | null
    existing: string
  }>(
    `SELECT p.code_piece,
            p.designation,
            v.indice,
            (SELECT count(*) FROM public.gammes g WHERE g.piece_technique_version_id = v.id)::text AS existing
       FROM public.piece_technique_versions v
       JOIN public.pieces_techniques p ON p.id = v.piece_technique_id
      WHERE v.id = $1`,
    [versionId]
  )
  const row = res.rows[0]
  return {
    codePiece: row?.code_piece ?? null,
    designation: row?.designation ?? null,
    indice: row?.indice ?? null,
    rank: Number(row?.existing ?? "0") + 1,
  }
}

export async function repoCreateGamme(versionId: string, body: CreateGammeBodyDTO, audit: AuditContext): Promise<GammeRow> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await assertVersionExists(client, versionId)

    const naming = await readGammeNamingContext(client, versionId)
    const nom = resolveGammeName(body.nom, naming)

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
        nom,
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

/* -------------------------------------------------------------------------- */
/* #433 — Préparer une RÉVISION d'une gamme figée                             */
/* -------------------------------------------------------------------------- */

async function columnExists(
  tx: Pick<PoolClient, "query">,
  table: string,
  column: string
): Promise<boolean> {
  const res = await tx.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column]
  )
  return Boolean(res.rows[0]?.present)
}

/**
 * Colonnes à recopier d'une ligne à l'autre : tout SAUF l'identité et les
 * traces d'écriture, qui doivent être neuves.
 *
 * La liste est lue dans le catalogue plutôt qu'écrite en dur : une colonne
 * ajoutée plus tard aux opérations (un référentiel Méthodes, un temps, un lien
 * de finition) est reprise automatiquement. Une liste figée aurait perdu cette
 * donnée en silence, ce qui est exactement ce qu'une révision ne doit pas faire.
 */
async function copyableColumns(
  tx: Pick<PoolClient, "query">,
  table: string,
  excluded: string[]
): Promise<string[]> {
  const res = await tx.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND is_generated = 'NEVER'
        AND column_name <> ALL($2::text[])
      ORDER BY ordinal_position`,
    [table, excluded]
  )
  return res.rows.map((row) => row.column_name)
}

export type GammeRevisionResult = { gamme: GammeRow; operations_copied: number; replayed: boolean }

/**
 * Duplique une gamme et ses opérations dans un NOUVEAU BROUILLON.
 *
 * Pourquoi ce point d'entrée existe
 * ---------------------------------
 * Une gamme `APPLICABLE` est volontairement immuable : les OF lancés et les
 * snapshots historiques s'appuient dessus. « Ajouter une opération » y est donc
 * grisé — sans issue. Cette opération donne la suite : repartir de la définition
 * figée dans un brouillon modifiable.
 *
 * Garanties
 * ---------
 * · atomique — une seule transaction, entête + opérations + liens de finition ;
 * · fidèle — phases, ordre, référentiels, temps et taux gelés sont recopiés ;
 * · non destructive — la gamme source n'est PAS touchée, la gamme courante non
 *   plus (le brouillon n'est jamais `is_current`) ;
 * · idempotente — la même `Idempotency-Key` rend la même révision ;
 * · auditée.
 */
export async function repoCreateGammeRevision(
  gammeId: string,
  body: { expected_updated_at?: string | null; nom?: string | null },
  audit: AuditContext,
  idempotencyKey?: string | null
): Promise<GammeRevisionResult> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const lineageReady =
      (await columnExists(client, "gammes", "source_gamme_id"))
      && (await columnExists(client, "gammes", "revision_idempotency_key"))
    if (!lineageReady) {
      throw new HttpError(
        503,
        "GAMME_REVISION_SCHEMA_UPGRADE_REQUIRED",
        "Le patch additif 20260731_gamme_revision_lineage doit être appliqué sur cet environnement avant de préparer une révision de gamme."
      )
    }

    const sourceRes = await client.query<{
      id: string
      piece_technique_version_id: string
      nom: string | null
      code: string | null
      designation: string | null
      commentaire: string | null
      statut: GammeStatutDTO
      updated_at: string
    }>(
      `SELECT id::text AS id, piece_technique_version_id::text AS piece_technique_version_id,
              nom, code, designation, commentaire, statut, updated_at::text AS updated_at
         FROM public.gammes WHERE id = $1 FOR UPDATE`,
      [gammeId]
    )
    const source = sourceRes.rows[0]
    if (!source) {
      await client.query("ROLLBACK").catch(() => {})
      throw new HttpError(404, "NOT_FOUND", "Gamme introuvable")
    }

    if (source.statut !== "APPLICABLE" && source.statut !== "OBSOLETE") {
      throw new HttpError(
        409,
        "GAMME_REVISION_SOURCE_NOT_FROZEN",
        "Seule une gamme figée (applicable ou obsolète) peut être préparée en révision."
      )
    }

    // Verrou optimiste : la gamme affichée doit être celle qu'on duplique.
    if (body.expected_updated_at && body.expected_updated_at !== source.updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La gamme a été modifiée entre-temps")
    }

    // Rejeu : la même clé sur la même gamme source rend la révision déjà créée.
    if (idempotencyKey) {
      const replay = await client.query<GammeRow>(
        `SELECT ${GAMME_COLS} FROM public.gammes
          WHERE source_gamme_id = $1 AND revision_idempotency_key = $2
          LIMIT 1`,
        [gammeId, idempotencyKey]
      )
      const existing = replay.rows[0]
      if (existing) {
        const counted = await client.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM public.pieces_techniques_operations WHERE gamme_id = $1`,
          [existing.id]
        )
        await client.query("COMMIT")
        return { gamme: existing, operations_copied: Number(counted.rows[0]?.total ?? "0"), replayed: true }
      }
    }

    const naming = await readGammeNamingContext(client, source.piece_technique_version_id)
    const nom = resolveGammeName(body.nom ?? null, naming)

    // La révision naît BROUILLON et jamais courante : tant qu'elle n'est pas
    // publiée, la production continue de suivre la gamme applicable.
    const createdRes = await client.query<GammeRow>(
      `INSERT INTO public.gammes
        (piece_technique_version_id, nom, code, designation, commentaire, statut, is_current,
         source_gamme_id, revision_idempotency_key, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'BROUILLON',false,$6,$7,$8,$8)
       RETURNING ${GAMME_COLS}`,
      [
        source.piece_technique_version_id,
        nom,
        source.code,
        source.designation,
        source.commentaire,
        gammeId,
        idempotencyKey ?? null,
        audit.user_id,
      ]
    )
    const created = createdRes.rows[0]

    const opColumns = await copyableColumns(client, "pieces_techniques_operations", [
      "id",
      "gamme_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ])
    const opColumnList = opColumns.map((c) => `"${c}"`).join(", ")
    const copiedOps = await client.query<{ new_id: string; old_id: string }>(
      `WITH copied AS (
         INSERT INTO public.pieces_techniques_operations
           (gamme_id, ${opColumnList}, created_by, updated_by)
         SELECT $2::uuid, ${opColumns.map((c) => `o."${c}"`).join(", ")}, $3, $3
           FROM public.pieces_techniques_operations o
          WHERE o.gamme_id = $1
          ORDER BY o.ordre ASC, o.phase ASC, o.created_at ASC
         RETURNING id::text AS new_id, ordre, phase
       )
       SELECT c.new_id,
              (SELECT o.id::text
                 FROM public.pieces_techniques_operations o
                WHERE o.gamme_id = $1 AND o.ordre = c.ordre AND o.phase IS NOT DISTINCT FROM c.phase
                LIMIT 1) AS old_id
         FROM copied c`,
      [gammeId, created.id, audit.user_id]
    )

    // Liens de finition : chaque ligne suit SON opération dupliquée. Une
    // finition orpheline serait pire qu'absente.
    const finitionsTable = await client.query<{ present: boolean }>(
      `SELECT to_regclass('public.gamme_operation_finitions') IS NOT NULL AS present`
    )
    if (finitionsTable.rows[0]?.present) {
      const finitionColumns = await copyableColumns(client, "gamme_operation_finitions", [
        "id",
        "gamme_id",
        "gamme_operation_id",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
      ])
      const finitionList = finitionColumns.map((c) => `"${c}"`).join(", ")
      for (const pair of copiedOps.rows) {
        if (!pair.old_id) continue
        await client.query(
          `INSERT INTO public.gamme_operation_finitions
             (gamme_id, gamme_operation_id, ${finitionList}, created_by, updated_by)
           SELECT $2::uuid, $3::uuid, ${finitionColumns.map((c) => `f."${c}"`).join(", ")}, $4, $4
             FROM public.gamme_operation_finitions f
            WHERE f.gamme_operation_id = $1::uuid`,
          [pair.old_id, created.id, pair.new_id, audit.user_id]
        )
      }
    }

    await insertAudit(client, audit, "gammes.revision.create", "gamme", created.id, {
      source_gamme_id: gammeId,
      source_statut: source.statut,
      piece_technique_version_id: source.piece_technique_version_id,
      operations_copied: copiedOps.rowCount ?? 0,
    })

    await client.query("COMMIT")
    return { gamme: created, operations_copied: copiedOps.rowCount ?? 0, replayed: false }
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
