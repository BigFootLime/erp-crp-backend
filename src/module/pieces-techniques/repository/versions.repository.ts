import { copyGammeOperationsTx } from "../../gammes/repository/gammes.repository"
// src/module/pieces-techniques/repository/versions.repository.ts
// GPAO B2.1 — repository des versions/indices d'une pièce technique.
import type { PoolClient } from "pg"
import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { generatePieceTechniqueBusinessCode } from "../../../shared/codes/code-generator.service"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import { freezePieceVersionRequirements } from "../services/document-policy.service"
import type { AuditContext } from "./pieces-techniques.repository"
import { COPY_VERSION_PURCHASES_SQL } from "./version-purchases.sql"
import { canCarryMinorRevisionDocuments, copyMinorRevisionDocumentsTx } from "./minor-revision-documents"
import { canAutoFollowCompatibleRevision } from "../../production/repository/effective-preparation-version.sql"
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
  indice_externe_original: string | null
  indice_externe_normalise: string | null
  version_interne: number | null
  code_metier: string | null
  code_metier_normalise: string | null
  plan_reference: string | null
  matiere_prevue: string | null
  statut: VersionStatutDTO
  is_current: boolean
  commentaire_revision: string | null
  type_changement: "EVOLUTION" | "MODIFICATION" | null
  raison_changement: string | null
  motif_modification: string | null
  impact_interchangeabilite: boolean | null
  impact_parents: string | null
  valide_par: number | null
  date_validation: string | null
  date_application: string | null
  date_effet: string | null
  commentaire_validation: string | null
  date_revision: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
  manufacturing_mode: "SIMPLE" | "ASSEMBLY"
  assembly_supply_strategy: "MAKE_TO_ORDER" | "INTERNAL_CONTRACT"
  copied_from_version_id: string | null
  change_level: "MAJOR" | "MINOR"
  packaging_policy: {mode:"GLOBAL"|"UNIT"|"LOT";lotSize:number|null}
}

const VERSION_COLUMNS = `
  id::text AS id, piece_technique_id::text AS piece_technique_id, indice,
  indice_externe_original, indice_externe_normalise, version_interne, code_metier, code_metier_normalise,
  plan_reference, matiere_prevue,
  statut, is_current, commentaire_revision, type_changement, raison_changement, impact_interchangeabilite,
  motif_modification, impact_parents, valide_par, date_validation::text AS date_validation, date_application::text AS date_application,
  date_effet::text AS date_effet,
  commentaire_validation, date_revision::text AS date_revision, created_at::text AS created_at,
  updated_at::text AS updated_at, created_by, updated_by,
  manufacturing_mode, assembly_supply_strategy, copied_from_version_id::text, change_level, packaging_policy
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

async function assertPieceExists(tx: Pick<PoolClient, "query">, pieceId: string): Promise<boolean> {
  const res = await tx.query<{ ensemble: boolean }>(`SELECT ensemble FROM public.pieces_techniques WHERE id = $1 AND deleted_at IS NULL`, [pieceId])
  if (res.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Pièce technique introuvable")
  return res.rows[0]?.ensemble === true
}

async function assertVersionEffectiveToday(
  tx: Pick<PoolClient, "query">,
  dateEffet: string | null
): Promise<void> {
  if (!dateEffet) return
  const result = await tx.query<{ is_future: boolean }>(
    `SELECT $1::date > CURRENT_DATE AS is_future`,
    [dateEffet]
  )
  if (result.rows[0]?.is_future) {
    throw new HttpError(
      422,
      "VERSION_EFFECTIVE_DATE_FUTURE",
      "La date d'effet de la version est dans le futur : choisissez aujourd'hui ou une date antérieure pour lancer un OF.",
      { date_effet: dateEffet }
    )
  }
}

export type PieceTechniqueVersionCloneResult = PieceTechniqueVersionRow & {
  copied: {
    current_gamme: boolean
    gamme_operations: number
    version_nomenclature_lines: number
  }
}

async function generateVersionBusinessCode(
  tx: Pick<PoolClient, "query">,
  pieceTechniqueId: string,
  planReference: string | null | undefined,
  indiceExterne: string
): Promise<string> {
  if (!planReference?.trim()) {
    throw new HttpError(400, "PLAN_REFERENCE_REQUIRED", "La référence plan est requise pour générer le code métier de version.")
  }
  const piece = await tx.query<{ client_id: string | null; code_client: string | null }>(
    `SELECT client_id::text AS client_id, code_client
       FROM public.pieces_techniques
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [pieceTechniqueId]
  )
  const source = piece.rows[0]
  if (!source) throw new HttpError(404, "NOT_FOUND", "Pièce technique introuvable")
  return generatePieceTechniqueBusinessCode(tx, {
    clientId: source.client_id,
    clientCode: source.code_client,
    planReference,
    indiceExterne,
  })
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
    const isAssembly = await assertPieceExists(client, pieceTechniqueId)
    await client.query('SELECT id FROM public.pieces_techniques WHERE id=$1::uuid FOR UPDATE',[pieceTechniqueId]);
    const priorVersion=await client.query(`SELECT 1 FROM public.piece_technique_versions WHERE piece_technique_id=$1::uuid LIMIT 1`,[pieceTechniqueId]);
    if(priorVersion.rowCount && (body.client_requirement_confirmed!==true || (body.raison_changement?.trim().length??0)<3)) throw new HttpError(422,"CLIENT_REVISION_REQUIRED","Utilisez Nouveau plan / exigence client pour créer une révision supplémentaire.");
    const codeMetier = await generateVersionBusinessCode(client, pieceTechniqueId, body.plan_reference, body.indice)

    const res = await client.query<PieceTechniqueVersionRow>(
      `INSERT INTO public.piece_technique_versions
        (piece_technique_id, indice, indice_externe_original, plan_reference, matiere_prevue, code_metier, motif_modification, date_effet, statut, is_current,
         commentaire_revision, type_changement, raison_changement, impact_interchangeabilite, impact_parents,
          date_revision, created_by, updated_by, manufacturing_mode, assembly_supply_strategy, packaging_policy)
        VALUES ($1,$2,$2,$3,$4,$5,$8,$9::date,'BROUILLON',false,$6,$7,$8,$10,$11, now(), $12,$12,$13,$14,$15::jsonb)
       RETURNING ${VERSION_COLUMNS}`,
      [
        pieceTechniqueId,
        body.indice,
        body.plan_reference ?? null,
        body.matiere_prevue ?? null,
        codeMetier,
        body.commentaire_revision ?? null,
        body.type_changement ?? null,
        body.raison_changement ?? null,
        body.date_effet ?? null,
        body.impact_interchangeabilite ?? null,
        body.impact_parents ?? null,
        audit.user_id,
        body.manufacturing_mode ?? (isAssembly ? "ASSEMBLY" : "SIMPLE"),
        body.assembly_supply_strategy ?? "MAKE_TO_ORDER",
        JSON.stringify(body.packaging_policy ?? {mode:"GLOBAL",lotSize:null}),
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
    const cur = await client.query<PieceTechniqueVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM public.piece_technique_versions
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
    if(current.change_level==="MINOR"&&body.indice!==undefined&&body.indice.trim().toUpperCase()!==current.indice.trim().toUpperCase())throw new HttpError(422,"MINOR_INDEX_CHANGED","L’indice d’une évolution mineure doit rester identique à sa version source.")
    if(current.change_level==="MINOR"&&body.impact_interchangeabilite===true)throw new HttpError(422,"MINOR_INTERCHANGEABILITY","Une modification non interchangeable nécessite une nouvelle version majeure.")

    const nextIndice = body.indice ?? current.indice
    const nextPlanReference = body.plan_reference === undefined ? current.plan_reference : body.plan_reference
    const codeMetier = body.indice !== undefined || body.plan_reference !== undefined
      ? await generateVersionBusinessCode(client, pieceTechniqueId, nextPlanReference, nextIndice)
      : null

    const sets: string[] = []
    const values: unknown[] = []
    const push = (col: string, val: unknown) => {
      values.push(val)
      sets.push(`${col} = $${values.length}`)
    }
    if (body.indice !== undefined) {
      push("indice", body.indice)
      push("indice_externe_original", body.indice)
    }
    if (body.plan_reference !== undefined) push("plan_reference", body.plan_reference)
    if (codeMetier) push("code_metier", codeMetier)
    if (body.matiere_prevue !== undefined) push("matiere_prevue", body.matiere_prevue)
    if (body.commentaire_revision !== undefined) push("commentaire_revision", body.commentaire_revision)
    if (body.type_changement !== undefined) push("type_changement", body.type_changement)
    if (body.raison_changement !== undefined) push("raison_changement", body.raison_changement)
    if (body.impact_interchangeabilite !== undefined) push("impact_interchangeabilite", body.impact_interchangeabilite)
    if (body.impact_parents !== undefined) push("impact_parents", body.impact_parents)
    if (body.date_effet !== undefined) push("date_effet", body.date_effet)
    if (body.manufacturing_mode !== undefined) push("manufacturing_mode", body.manufacturing_mode)
    if (body.assembly_supply_strategy !== undefined) push("assembly_supply_strategy", body.assembly_supply_strategy)
    if (body.packaging_policy !== undefined) push("packaging_policy", JSON.stringify(body.packaging_policy))

    values.push(audit.user_id)
    sets.push(`updated_by = $${values.length}`)
    sets.push(`updated_at = now()`)

    values.push(versionId)
    const res = await client.query<PieceTechniqueVersionRow>(
      `UPDATE public.piece_technique_versions SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${VERSION_COLUMNS}`,
      values
    )
    const row = res.rows[0]
    await insertAudit(client, audit, "pieces-techniques.version.update", versionId, {
      piece_technique_id: pieceTechniqueId,
      ...(body.manufacturing_mode !== undefined ? { manufacturing_mode: { before: current.manufacturing_mode, after: row.manufacturing_mode } } : {}),
      ...(body.assembly_supply_strategy !== undefined ? { assembly_supply_strategy: { before: current.assembly_supply_strategy, after: row.assembly_supply_strategy } } : {}),
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
    const cur = await client.query<PieceTechniqueVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM public.piece_technique_versions
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

    // Les statuts validés sont immuables. Une répétition du même ordre est donc
    // idempotente et ne doit pas émettre un UPDATE que le trigger refuserait.
    if (current.statut === toStatut && (current.statut === "APPLICABLE" || current.statut === "OBSOLETE")) {
      await client.query("COMMIT")
      return current
    }

    if (toStatut === "APPLICABLE") {
      await assertVersionEffectiveToday(client, current.date_effet)
    }

    // #227 — geler les exigences AVANT de rendre l'indice immuable. Le trigger
    // PostgreSQL interdit toute modification fonctionnelle d'une version déjà
    // APPLICABLE ; un gel exécuté après la promotion fait échouer la transaction.
    // Le gel reste atomique : une promotion ultérieure en échec l'annule aussi.
    let frozen: Awaited<ReturnType<typeof freezePieceVersionRequirements>> = null
    if (toStatut === "APPLICABLE" && current.statut !== "APPLICABLE") {
      frozen = await freezePieceVersionRequirements(client, {
        pieceTechniqueId,
        versionId,
        userId: audit.user_id,
      })
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
      document_requirements_frozen: frozen ? !frozen.already_frozen : false,
      document_requirements_count: frozen?.frozen_count ?? null,
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

/**
 * Publication guidée d'un indice dans une transaction unique. La transition
 * intermédiaire EN_VALIDATION est conservée dans la règle métier, sans
 * exposer au client un état partiellement publié si le gel documentaire
 * échoue ensuite.
 */
export async function repoPublishVersion(
  pieceTechniqueId: string,
  versionId: string,
  extra: {
    date_application: string | null;
    date_effet?: string | null;
    commentaire_validation: string | null;
    expected_updated_at?: string;
  },
  audit: AuditContext
): Promise<PieceTechniqueVersionRow | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const cur = await client.query<PieceTechniqueVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM public.piece_technique_versions
        WHERE id = $1 AND piece_technique_id = $2
        FOR UPDATE`,
      [versionId, pieceTechniqueId]
    )
    const current = cur.rows[0] ?? null
    if (!current) {
      await client.query("ROLLBACK").catch(() => {})
      return null
    }
    if (extra.expected_updated_at && extra.expected_updated_at !== current.updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La version a été modifiée entre-temps")
    }

    if (current.statut === "OBSOLETE") {
      throw new HttpError(409, "VERSION_NOT_PUBLISHABLE", "Une version obsolète ne peut pas redevenir applicable — créez un nouvel indice")
    }
    const targetDateEffet = extra.date_effet !== undefined ? extra.date_effet : current.date_effet
    await assertVersionEffectiveToday(client, targetDateEffet)
    if (current.statut === "APPLICABLE") {
      // Une ancienne publication peut avoir une date d'effet future : elle est
      // alors Applicable dans le dossier mais inutilisable par le moteur OF.
      // Le parcours guidé peut la rendre effective sans changer d'indice.
      if (extra.date_effet !== undefined) {
        const updated = await client.query<PieceTechniqueVersionRow>(
          `UPDATE public.piece_technique_versions
              SET date_effet = $2::date, updated_at = now(), updated_by = $3
            WHERE id = $1
            RETURNING ${VERSION_COLUMNS}`,
          [versionId, extra.date_effet, audit.user_id]
        )
        const row = updated.rows[0]
        if (!row) throw new Error("Impossible de mettre à jour la date d'effet de la version technique")
        await insertAudit(client, audit, "pieces-techniques.version.publish", versionId, {
          piece_technique_id: pieceTechniqueId,
          from: "APPLICABLE",
          to: "APPLICABLE",
          date_effet_updated: true,
          date_effet: extra.date_effet,
        })
        await client.query("COMMIT")
        return row
      }
      await client.query("COMMIT")
      return current
    }

    if (current.statut === "BROUILLON") {
      await client.query(
        `UPDATE public.piece_technique_versions
            SET statut = 'EN_VALIDATION', is_current = false, updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [versionId, audit.user_id]
      )
    }

    // Le gel doit précéder la promotion finale : une version APPLICABLE est
    // immuable au niveau PostgreSQL. L'ordre inverse déclenchait SQLSTATE 55000.
    const frozen = await freezePieceVersionRequirements(client, {
      pieceTechniqueId,
      versionId,
      userId: audit.user_id,
    })

    // Déclasser l'ancienne applicable avant de promouvoir la nouvelle afin de
    // respecter l'index unique partiel, y compris sous concurrence.
    await client.query(
      `UPDATE public.piece_technique_versions
          SET statut = 'OBSOLETE', is_current = false, updated_at = now(), updated_by = $3
        WHERE piece_technique_id = $1 AND statut = 'APPLICABLE' AND id <> $2`,
      [pieceTechniqueId, versionId, audit.user_id]
    )
    const published = await client.query<PieceTechniqueVersionRow>(
      `UPDATE public.piece_technique_versions SET
         statut = 'APPLICABLE',
         is_current = true,
         valide_par = $2,
         date_validation = now(),
         date_application = COALESCE($3::date, date_application, CURRENT_DATE),
         commentaire_validation = COALESCE($4, commentaire_validation),
         date_effet = CASE WHEN $5::boolean THEN $6::date ELSE date_effet END,
         updated_at = now(), updated_by = $2
       WHERE id = $1
       RETURNING ${VERSION_COLUMNS}`,
      [
        versionId,
        audit.user_id,
        extra.date_application,
        extra.commentaire_validation,
        extra.date_effet !== undefined,
        extra.date_effet ?? null,
      ]
    )
    const row = published.rows[0]
    if (!row) throw new Error("Impossible de publier la version technique")

    await insertAudit(client, audit, "pieces-techniques.version.publish", versionId, {
      piece_technique_id: pieceTechniqueId,
      from: current.statut,
      to: "APPLICABLE",
      document_requirements_frozen: frozen ? !frozen.already_frozen : false,
      document_requirements_count: frozen?.frozen_count ?? null,
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

/** Copy immutable technical evidence; transaction and intent are owned by the caller. */
async function cloneTechnicalVersionTx(
  client: PoolClient, pieceTechniqueId: string, sourceVersionId: string,
  body: CreateNextVersionBodyDTO, audit: AuditContext, routineEdit: boolean,
  options: { autoFollowDraftOrders?: boolean } = {},
): Promise<PieceTechniqueVersionCloneResult> {
    // Les rangs de nomenclature sont uniques par pièce, toutes versions confondues.
    // Même verrou que les ajouts/modifications de composants, avant toute allocation.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('piece-bom:' || $1::text, 0))", [pieceTechniqueId])
    const piece = (await client.query<{ statut: string }>("SELECT statut::text FROM public.pieces_techniques WHERE id=$1::uuid AND deleted_at IS NULL FOR UPDATE", [pieceTechniqueId])).rows[0]
    if (!piece) throw new HttpError(404, "PIECE_NOT_FOUND", "Pièce technique introuvable.")
    if (piece.statut === "OBSOLETE") throw new HttpError(409, "PIECE_ARCHIVED", "Cette pièce est archivée ; son dossier reste consultable.")
    const src = await client.query<PieceTechniqueVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM public.piece_technique_versions
       WHERE id = $1 AND piece_technique_id = $2 FOR SHARE`,
      [sourceVersionId, pieceTechniqueId]
    )
    if (src.rowCount === 0) {
      throw new HttpError(404, "NOT_FOUND", "Version source introuvable")
    }
    const source = src.rows[0]
    const sameIndex=body.indice.trim().toUpperCase()===source.indice.trim().toUpperCase()
    const changeLevel=body.change_level??(sameIndex?"MINOR":"MAJOR")
    if(changeLevel==="MINOR"&&!sameIndex)throw new HttpError(422,"MINOR_INDEX_CHANGED","Une évolution mineure conserve l’indice client. Choisissez une modification majeure pour un nouvel indice.")
    const planReference = body.plan_reference ?? source.plan_reference
    const codeMetier = await generateVersionBusinessCode(client, pieceTechniqueId, planReference, body.indice)

    const res = await client.query<PieceTechniqueVersionRow>(
      `INSERT INTO public.piece_technique_versions
        (piece_technique_id, indice, indice_externe_original, plan_reference, matiere_prevue, code_metier, motif_modification, date_effet, statut, is_current,
         commentaire_revision, type_changement, raison_changement, impact_interchangeabilite, impact_parents,
          date_revision, created_by, updated_by, manufacturing_mode, assembly_supply_strategy, packaging_policy, copied_from_version_id, change_level)
        VALUES ($1,$2,$2,$3,$4,$5,$8,$9::date,'BROUILLON',false,$6,$7,$8,$10,$11, now(), $12,$12,$13,$14,$15::jsonb,$16::uuid,$17)
       RETURNING ${VERSION_COLUMNS}`,
      [
        pieceTechniqueId,
        body.indice,
        planReference,
        body.matiere_prevue ?? source.matiere_prevue,
        codeMetier,
        body.commentaire_revision ?? null,
        body.type_changement ?? null,
        body.raison_changement ?? null,
        body.date_effet ?? null,
        changeLevel==="MAJOR",
        body.impact_parents ?? null,
        audit.user_id,
        body.manufacturing_mode ?? source.manufacturing_mode,
        body.assembly_supply_strategy ?? source.assembly_supply_strategy,
        JSON.stringify(body.packaging_policy ?? source.packaging_policy),
        sourceVersionId,
        changeLevel,
      ]
    )
    const row = res.rows[0]

    const copied = {
      current_gamme: false,
      gamme_operations: 0,
      version_nomenclature_lines: 0,
    }

    const operationIds = new Map<string, string>()
    let copiedGammeId: string | null = null
    const sourceGamme = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM public.gammes
        WHERE piece_technique_version_id = $1
          AND is_current = true
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [sourceVersionId]
    )
    const sourceGammeId = sourceGamme.rows[0]?.id
    if (sourceGammeId) {
      const gamme = await client.query<{ id: string }>(
        `INSERT INTO public.gammes
          (piece_technique_version_id, nom, code, designation, commentaire, statut, is_current, created_by, updated_by)
         SELECT $1, nom, code, designation, commentaire, 'BROUILLON', true, $3, $3
           FROM public.gammes
          WHERE id = $2
         RETURNING id::text AS id`,
        [row.id, sourceGammeId, audit.user_id]
      )
      copiedGammeId = gamme.rows[0]?.id ?? null
      if (!copiedGammeId) throw new Error("Impossible de copier la gamme courante de la version source")
      copied.current_gamme = true

      copied.gamme_operations = await copyGammeOperationsTx(client, sourceGammeId, copiedGammeId, audit.user_id, operationIds)
    }

    // Pin the effective legacy BOM to its source before introducing a scoped copy.
    // Otherwise the first scoped BOM would hide the historical unscoped lines.
    const pinnedLegacyBom = await client.query(`UPDATE public.pieces_techniques_nomenclature n
      SET parent_piece_technique_version_id=$2::uuid
      WHERE n.parent_piece_technique_id=$1::uuid AND n.parent_piece_technique_version_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM public.pieces_techniques_nomenclature scoped
          WHERE scoped.parent_piece_technique_id=$1::uuid AND scoped.parent_piece_technique_version_id IS NOT NULL)`, [pieceTechniqueId, sourceVersionId])
    const copiedBom = await client.query(
      `INSERT INTO public.pieces_techniques_nomenclature
        (parent_piece_technique_id, parent_piece_technique_version_id, child_piece_technique_id,
         child_piece_technique_version_id, child_article_id, rang, quantite, repere, designation)
       SELECT n.parent_piece_technique_id, $2::uuid, n.child_piece_technique_id,
              n.child_piece_technique_version_id, n.child_article_id,
              (r.max_rang + 10 * row_number() OVER (ORDER BY n.rang, n.id))::integer,
              n.quantite, n.repere, n.designation
         FROM public.pieces_techniques_nomenclature n
         CROSS JOIN (
           SELECT COALESCE(MAX(rang), 0)::bigint AS max_rang
             FROM public.pieces_techniques_nomenclature
            WHERE parent_piece_technique_id = $1::uuid
         ) r
        WHERE n.parent_piece_technique_id = $1::uuid
          AND n.parent_piece_technique_version_id = $3::uuid`,
      [pieceTechniqueId, row.id, sourceVersionId]
    )
    copied.version_nomenclature_lines = copiedBom.rowCount ?? 0

    const linkedPurchases = await client.query<{ gamme_operation_id: string }>(
      `SELECT DISTINCT gamme_operation_id::text FROM public.pieces_techniques_achats
       WHERE piece_technique_id=$1::uuid AND piece_technique_version_id=$2::uuid AND gamme_operation_id IS NOT NULL`, [pieceTechniqueId, sourceVersionId])
    if (linkedPurchases.rows.some(purchase => !operationIds.has(purchase.gamme_operation_id)))
      throw new HttpError(409, "PURCHASE_OPERATION_NOT_COPIED", "Un achat vise une opération hors de la gamme courante. Vérifiez son rattachement avant de modifier le dossier.")
    const purchases = await client.query<{ old_id: string; new_id: string }>(
      COPY_VERSION_PURCHASES_SQL,
      [pieceTechniqueId, row.id, sourceVersionId, JSON.stringify(Object.fromEntries(operationIds)), copiedGammeId]
    )
    for (const purchase of purchases.rows) await client.query(`UPDATE public.gamme_operation_finitions target
      SET achat_ligne_id=$2::uuid FROM public.gamme_operation_finitions source
      WHERE source.achat_ligne_id=$1::uuid AND target.gamme_id=$3::uuid
        AND target.gamme_operation_id=($4::jsonb->>source.gamme_operation_id::text)::uuid AND target.slot=source.slot`,
      [purchase.old_id, purchase.new_id, copiedGammeId, JSON.stringify(Object.fromEntries(operationIds))])
    await client.query(`INSERT INTO public.piece_version_tool_requirements
      (piece_technique_version_id,id_outil,required_quantity,usage_notes,created_by,updated_by)
      SELECT $2::uuid,id_outil,required_quantity,usage_notes,$3,$3
      FROM public.piece_version_tool_requirements WHERE piece_technique_version_id=$1::uuid`,
      [sourceVersionId, row.id, audit.user_id])
    const copiedDocuments = canCarryMinorRevisionDocuments({ changeLevel, sourceIndex: source.indice,
      targetIndex: body.indice, sourcePlan: source.plan_reference, targetPlan: planReference })
      ? await copyMinorRevisionDocumentsTx(client, pieceTechniqueId, sourceVersionId, row.id, audit.user_id) : 0

    // The legacy compatibility inputs remain available, while #1833 pins every OF
    // selection. canAutoFollowCompatibleRevision therefore denies retargeting
    // even for a compatible minor revision or a legacy AUTO value.
    const autoFollowedOfIds: number[] = []
    const compatibleAutoTarget = canAutoFollowCompatibleRevision({
      state: { statut: "BROUILLON", technicalSnapshotSha256: null, technicalReadiness: "INCOMPLETE" },
      effectiveVersionId: sourceVersionId,
      sourceVersionId,
      sourceClientIndex: source.indice_externe_original?.trim() || source.indice.trim() || null,
      targetClientIndex: row.indice_externe_original?.trim() || row.indice.trim() || null,
      targetChangeLevel: row.change_level,
      targetInterchangeable: row.impact_interchangeabilite === true,
    })
    // Article reconfiguration also explicitly denies retargeting. Its caller-owned
    // transaction and this legacy option remain compatible with existing consumers.
    if (compatibleAutoTarget && options.autoFollowDraftOrders !== false) {
      const synchronized = await client.query<{ id: number }>(
        `UPDATE public.ordres_fabrication o SET
          technical_preparation=COALESCE(o.technical_preparation,'{}'::jsonb)||jsonb_build_object('selected_version_id',$2::text,'version_selection_mode','AUTO'),
          technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,updated_at=now(),updated_by=$3
        WHERE o.piece_technique_id=$1::uuid AND o.statut='BROUILLON'
          AND o.technical_snapshot_sha256 IS NULL AND COALESCE(o.technical_readiness,'')<>'VALIDATED'
          AND COALESCE(o.technical_preparation->>'version_selection_mode','AUTO')='AUTO'
          AND COALESCE(NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid,o.piece_technique_version_id)=$4::uuid
          AND EXISTS(SELECT 1 FROM public.piece_technique_versions source, public.piece_technique_versions target
            WHERE source.id=$4::uuid AND target.id=$2::uuid
              AND target.change_level='MINOR' AND COALESCE(target.impact_interchangeabilite,false)=false
              AND COALESCE(NULLIF(btrim(source.indice_externe_original),''),NULLIF(btrim(source.indice),'')) IS NOT NULL
              AND COALESCE(NULLIF(btrim(source.indice_externe_original),''),NULLIF(btrim(source.indice),''))=
                  COALESCE(NULLIF(btrim(target.indice_externe_original),''),NULLIF(btrim(target.indice),'')))
        RETURNING o.id::bigint::int AS id`,
        [pieceTechniqueId, row.id, audit.user_id, sourceVersionId],
      )
      if (synchronized.rowCount)
        await client.query("DELETE FROM public.of_preparation_evaluations WHERE of_id=ANY($1::bigint[])", [synchronized.rows.map((of) => of.id)])
      autoFollowedOfIds.push(...synchronized.rows.map((of) => of.id))
    }

    await insertAudit(client, audit, routineEdit ? "pieces-techniques.edit.prepare" : "pieces-techniques.version.create-next", row.id, {
      client_requirement_confirmed: body.client_requirement_confirmed === true,
      purpose: routineEdit ? "EDIT" : body.client_requirement_confirmed === true ? "CLIENT_PLAN" : "INTERNAL_CLONE",
      raison_changement: body.raison_changement,
      piece_technique_id: pieceTechniqueId,
      source_version_id: sourceVersionId,
      indice: row.indice,
      type_changement: row.type_changement,
      copied_documents: copiedDocuments,
      legacy_bom_lines_pinned: pinnedLegacyBom.rowCount ?? 0,
      auto_followed_of_ids: autoFollowedOfIds,
      copied,
    })
    return { ...row, copied }
}

/** Ordinary editing keeps the client plan/index. Repeated openings reuse its working definition. */
export async function repoPreparePieceEdit(pieceTechniqueId:string,audit:AuditContext){
  const client=await db.connect()
  try{
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('piece-bom:' || $1::text, 0))",[pieceTechniqueId])
    const piece=(await client.query<{statut:string}>("SELECT statut::text FROM public.pieces_techniques WHERE id=$1::uuid AND deleted_at IS NULL FOR UPDATE",[pieceTechniqueId])).rows[0]
    if(!piece)throw new HttpError(404,"PIECE_NOT_FOUND","Pièce technique introuvable.")
    if(piece.statut==="OBSOLETE")throw new HttpError(409,"PIECE_ARCHIVED","Cette pièce est archivée ; son dossier reste consultable.")
    const versions=(await client.query<PieceTechniqueVersionRow>(
      "SELECT "+VERSION_COLUMNS+" FROM public.piece_technique_versions WHERE piece_technique_id=$1::uuid ORDER BY CASE statut WHEN 'EN_VALIDATION' THEN 0 WHEN 'BROUILLON' THEN 1 ELSE 2 END,created_at DESC,version_interne DESC,id DESC FOR UPDATE",[pieceTechniqueId])).rows
    const working=versions.find(v=>["BROUILLON","EN_VALIDATION"].includes(v.statut))
    if(working){await client.query("COMMIT");return {version:working,created:false}}
    const source=versions.find(v=>v.statut==="APPLICABLE")??versions.find(v=>v.statut==="OBSOLETE")
    if(!source){await client.query("COMMIT");return {version:null,created:false}}
    const version=await cloneTechnicalVersionTx(client,pieceTechniqueId,source.id,{
      indice:source.indice,plan_reference:source.plan_reference,change_level:"MINOR",
      commentaire_revision:"Modification du dossier technique",raison_changement:"Modification du dossier technique",
      type_changement:"MODIFICATION",date_effet:null
    },audit,true)
    await client.query("COMMIT")
    return {version,created:true}
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}
  finally{client.release()}
}

/** Public client-plan changes require confirmation; internal clones may borrow their caller's transaction. */
export async function repoCreateNextVersion(
  pieceTechniqueId: string,
  sourceVersionId: string,
  body: CreateNextVersionBodyDTO,
  audit: AuditContext,
  transactionClient?: PoolClient,
  options: { autoFollowDraftOrders?: boolean } = {},
): Promise<PieceTechniqueVersionCloneResult> {
  if (!transactionClient && (body.client_requirement_confirmed !== true || (body.raison_changement?.trim().length ?? 0) < 3)) {
    throw new HttpError(422, "CLIENT_REVISION_REQUIRED", "Utilisez Nouveau plan client pour changer de version.")
  }
  const client = transactionClient ?? await db.connect()
  try {
    if (!transactionClient) await client.query("BEGIN")
    const result = await cloneTechnicalVersionTx(client, pieceTechniqueId, sourceVersionId, body, audit, false, options)
    if (!transactionClient) await client.query("COMMIT")
    return result
  } catch (error) {
    if (!transactionClient) await client.query("ROLLBACK").catch(() => {})
    if ((error as { code?: string })?.code === "23505") {
      throw new HttpError(409, "CONFLICT", "Une donnée du nouveau plan entre en conflit. Actualisez le dossier avant de réessayer.")
    }
    throw error
  } finally {
    if (!transactionClient) client.release()
  }
}
