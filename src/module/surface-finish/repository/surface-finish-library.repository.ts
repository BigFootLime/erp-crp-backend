// #210 — Bibliothèque de finitions : lecture, recherche, brouillons, révisions,
// transitions et documents. Toute écriture est transactionnelle et auditée.

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { generateSurfaceFinishCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  assertOptimisticVersion,
  assertRevisionContentMutable,
  assertSurfaceFinishTransition,
  assertTemplateVariablesAllowed,
  assertThicknessCoherent,
  normalizeThicknessUnit,
  thicknessToMicrometers,
  type SurfaceFinishStatus,
} from "../domain/surface-finish-policy";
import type {
  AttachDocumentBodyDTO,
  CreateFinishFamilyBodyDTO,
  CreateFinishBodyDTO,
  ListFinishesQueryDTO,
  RevisionPayloadDTO,
  TransitionRevisionBodyDTO,
  UpdateFinishBodyDTO,
  UpdateRevisionBodyDTO,
} from "../validators/surface-finish.validators";
import type {
  SurfaceFinishDetail,
  SurfaceFinishDocument,
  SurfaceFinishFamily,
  SurfaceFinishListResult,
  SurfaceFinishRevisionDetail,
  SurfaceFinishRevisionSummary,
  SurfaceFinishSummary,
} from "../types/surface-finish.types";

/* -------------------------------------------------------------------------- */
/* Colonnes et projections                                                     */
/* -------------------------------------------------------------------------- */

/** Projection d'une révision. `alias` permet de la réutiliser en RETURNING. */
export function revisionColumns(alias = "r"): string {
  const p = alias ? `${alias}.` : "";
  return `
    ${p}id::text AS id,
    ${p}finish_id::text AS finish_id,
    ${p}revision,
    ${p}statut,
    ${p}norme,
    ${p}reference_client,
    ${p}classe,
    ${p}substrat,
    ${p}epaisseur_min::float8 AS epaisseur_min,
    ${p}epaisseur_nominale::float8 AS epaisseur_nominale,
    ${p}epaisseur_max::float8 AS epaisseur_max,
    ${p}epaisseur_unite,
    ${p}couleur,
    ${p}teinte_ral,
    ${p}aspect,
    ${p}brillance,
    ${p}rugosite,
    ${p}durete,
    ${p}exigence_corrosion,
    ${p}pretraitement,
    ${p}posttraitement,
    ${p}zones_defaut,
    ${p}regles_masquage,
    ${p}criteres_acceptation,
    ${p}controles,
    ${p}certificat_requis,
    ${p}certificat_type,
    ${p}conditionnement_retour,
    ${p}unite_achat,
    ${p}designation_template,
    ${p}commentaire_template,
    ${p}template_version,
    ${p}date_effet::text AS date_effet,
    ${p}approbateur_user_id,
    ${p}approved_at::text AS approved_at,
    ${p}created_at::text AS created_at,
    ${p}updated_at::text AS updated_at
  `;
}

const FINISH_COLS = `
  f.id::text AS id,
  f.code,
  f.family_code,
  fam.label AS family_label,
  f.procede,
  f.designation_courte,
  f.designation_longue,
  f.description,
  f.synonymes,
  f.statut,
  f.current_revision_id::text AS current_revision_id,
  f.created_at::text AS created_at,
  f.updated_at::text AS updated_at,
  f.archived_at::text AS archived_at,
  f.archive_reason
`;

export type RevisionRow = {
  id: string;
  finish_id: string;
  revision: number;
  statut: SurfaceFinishStatus;
  norme: string | null;
  reference_client: string | null;
  classe: string | null;
  substrat: string | null;
  epaisseur_min: number | null;
  epaisseur_nominale: number | null;
  epaisseur_max: number | null;
  epaisseur_unite: string;
  couleur: string | null;
  teinte_ral: string | null;
  aspect: string | null;
  brillance: string | null;
  rugosite: string | null;
  durete: string | null;
  exigence_corrosion: string | null;
  pretraitement: string | null;
  posttraitement: string | null;
  zones_defaut: string[] | null;
  regles_masquage: string[] | null;
  criteres_acceptation: string | null;
  controles: string[] | null;
  certificat_requis: boolean;
  certificat_type: string | null;
  conditionnement_retour: string | null;
  unite_achat: string;
  designation_template: string | null;
  commentaire_template: string | null;
  template_version: number;
  date_effet: string | null;
  approbateur_user_id: number | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type FinishRow = {
  id: string;
  code: string;
  family_code: string;
  family_label: string | null;
  procede: string;
  designation_courte: string;
  designation_longue: string | null;
  description: string | null;
  synonymes: string[] | null;
  statut: SurfaceFinishStatus;
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archive_reason: string | null;
};

export function mapRevision(row: RevisionRow): SurfaceFinishRevisionDetail {
  return {
    id: row.id,
    finish_id: row.finish_id,
    revision: row.revision,
    statut: row.statut,
    norme: row.norme,
    reference_client: row.reference_client,
    classe: row.classe,
    substrat: row.substrat,
    epaisseur_min: row.epaisseur_min,
    epaisseur_nominale: row.epaisseur_nominale,
    epaisseur_max: row.epaisseur_max,
    epaisseur_unite: row.epaisseur_unite,
    couleur: row.couleur,
    teinte_ral: row.teinte_ral,
    aspect: row.aspect,
    brillance: row.brillance,
    rugosite: row.rugosite,
    durete: row.durete,
    exigence_corrosion: row.exigence_corrosion,
    pretraitement: row.pretraitement,
    posttraitement: row.posttraitement,
    zones_defaut: row.zones_defaut ?? [],
    regles_masquage: row.regles_masquage ?? [],
    criteres_acceptation: row.criteres_acceptation,
    controles: row.controles ?? [],
    certificat_requis: row.certificat_requis,
    certificat_type: row.certificat_type,
    conditionnement_retour: row.conditionnement_retour,
    unite_achat: row.unite_achat,
    designation_template: row.designation_template,
    commentaire_template: row.commentaire_template,
    template_version: row.template_version,
    date_effet: row.date_effet,
    approbateur_user_id: row.approbateur_user_id,
    approved_at: row.approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRevisionSummary(revision: SurfaceFinishRevisionDetail): SurfaceFinishRevisionSummary {
  return {
    id: revision.id,
    revision: revision.revision,
    statut: revision.statut,
    norme: revision.norme,
    classe: revision.classe,
    epaisseur_min: revision.epaisseur_min,
    epaisseur_nominale: revision.epaisseur_nominale,
    epaisseur_max: revision.epaisseur_max,
    epaisseur_unite: revision.epaisseur_unite,
    couleur: revision.couleur,
    teinte_ral: revision.teinte_ral,
    aspect: revision.aspect,
    certificat_requis: revision.certificat_requis,
    date_effet: revision.date_effet,
    updated_at: revision.updated_at,
  };
}

export async function insertFinishAudit(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> | null
): Promise<void> {
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
  });
}

/* -------------------------------------------------------------------------- */
/* Familles                                                                    */
/* -------------------------------------------------------------------------- */

export async function repoListFinishFamilies(): Promise<SurfaceFinishFamily[]> {
  const res = await db.query<SurfaceFinishFamily>(
    `SELECT code, label, description, commentaire_template, sort_order, is_active
     FROM public.surface_finish_families
     ORDER BY sort_order, label`
  );
  return res.rows;
}

/** Family parameterization is auditable and separate from a finish draft. */
export async function repoCreateFinishFamily(
  body: CreateFinishFamilyBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishFamily> {
  assertTemplateVariablesAllowed(body.commentaire_template ?? "");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<SurfaceFinishFamily>(
      `INSERT INTO public.surface_finish_families
         (code, label, description, commentaire_template, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING code, label, description, commentaire_template, sort_order, is_active`,
      [body.code, body.label, body.description, body.commentaire_template, body.sort_order]
    );
    const family = res.rows[0];
    await insertFinishAudit(client, audit, "finitions.family.create", "surface_finish_family", family.code, {
      code: family.code,
      label: family.label,
      has_commentaire_template: Boolean(family.commentaire_template),
    });
    await client.query("COMMIT");
    return family;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new HttpError(409, "SURFACE_FINISH_FAMILY_DUPLICATE", "Une famille de finition porte dÃ©jÃ  ce code.");
    }
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Recherche                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recherche serveur bornée. Jamais de « charger toute la bibliothèque » : la
 * pagination est obligatoire et plafonnée par le validateur.
 *
 * Recherche par code, désignation, famille, procédé, norme, couleur/teinte,
 * épaisseur et synonyme. La norme et la couleur vivent sur la RÉVISION : la
 * jointure latérale retient la révision active, sinon la plus récente.
 */
export async function repoListFinishes(
  filters: ListFinishesQueryDTO,
  viewerUserId: number
): Promise<SurfaceFinishListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  // #226 — Le favori est PERSONNEL : il est joint sur l'utilisateur qui
  // interroge, jamais agrégé. Poussé en premier pour que `$1` soit stable.
  const viewer = push(viewerUserId);

  if (filters.only_selectable) {
    // Depuis une gamme : uniquement ce qui est réellement applicable.
    where.push(`f.statut = 'ACTIVE'`);
    where.push(`rev.id IS NOT NULL AND rev.statut = 'ACTIVE'`);
  } else if (filters.statut) {
    where.push(`f.statut = ${push(filters.statut)}`);
  } else if (!filters.include_archived) {
    // #226 — Les archives ne remontent que si on les demande explicitement,
    // OU si l'utilisateur filtre justement sur le statut ARCHIVEE ci-dessus.
    where.push(`f.statut <> 'ARCHIVEE'`);
  }

  if (filters.only_favorites) where.push(`fav.user_id IS NOT NULL`);

  if (filters.family_code) where.push(`f.family_code = ${push(filters.family_code)}`);
  if (filters.procede) {
    where.push(`public.surface_finish_norm(f.procede) LIKE public.surface_finish_norm(${push(`%${filters.procede}%`)})`);
  }
  if (filters.norme) {
    where.push(`public.surface_finish_norm(rev.norme) LIKE public.surface_finish_norm(${push(`%${filters.norme}%`)})`);
  }
  if (filters.couleur) {
    const needle = push(`%${filters.couleur}%`);
    where.push(
      `(public.surface_finish_norm(rev.couleur) LIKE public.surface_finish_norm(${needle})
        OR public.surface_finish_norm(rev.teinte_ral) LIKE public.surface_finish_norm(${needle}))`
    );
  }
  if (filters.epaisseur_um !== null && filters.epaisseur_um !== undefined) {
    // Comparaison en micromètres : la révision peut être saisie dans une autre unité.
    const target = push(filters.epaisseur_um);
    where.push(`(
      rev.id IS NOT NULL
      AND ${target}::numeric >= COALESCE(public.surface_finish_to_um(rev.epaisseur_min::numeric, rev.epaisseur_unite), 0)
      AND ${target}::numeric <= COALESCE(public.surface_finish_to_um(rev.epaisseur_max::numeric, rev.epaisseur_unite), 1e12)
    )`);
  }
  if (filters.q) {
    const needle = push(`%${filters.q}%`);
    const exact = push(filters.q);
    where.push(`(
      public.surface_finish_norm(f.code) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(f.designation_courte) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(f.designation_longue) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(f.procede) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(f.family_code) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(fam.label) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(rev.norme) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(rev.couleur) LIKE public.surface_finish_norm(${needle})
      OR public.surface_finish_norm(rev.teinte_ral) LIKE public.surface_finish_norm(${needle})
      OR EXISTS (
        SELECT 1 FROM unnest(f.synonymes) AS s(value)
        WHERE public.surface_finish_norm(s.value) LIKE public.surface_finish_norm(${needle})
           OR public.surface_finish_norm(s.value) = public.surface_finish_norm(${exact})
      )
    )`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const baseFrom = `
    FROM public.surface_finishes f
    LEFT JOIN public.surface_finish_families fam ON fam.code = f.family_code
    LEFT JOIN public.surface_finish_favorites fav
      ON fav.finish_id = f.id AND fav.user_id = ${viewer}::integer
    LEFT JOIN LATERAL (
      SELECT ${revisionColumns("r")}
      FROM public.surface_finish_revisions r
      WHERE r.finish_id = f.id
      ORDER BY (r.statut = 'ACTIVE') DESC, r.revision DESC
      LIMIT 1
    ) rev ON true
    ${whereSql}
  `;

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${baseFrom}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const offset = (filters.page - 1) * filters.page_size;
  const dataRes = await db.query<FinishRow & { rev_json: RevisionRow | null; favori: boolean }>(
    `SELECT ${FINISH_COLS},
            (fav.user_id IS NOT NULL) AS favori,
            CASE WHEN rev.id IS NULL THEN NULL ELSE to_jsonb(rev) END AS rev_json
     ${baseFrom}
     ORDER BY (fav.user_id IS NOT NULL) DESC, f.designation_courte, f.code
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.page_size, offset]
  );

  const items: SurfaceFinishSummary[] = dataRes.rows.map((row) => ({
    id: row.id,
    code: row.code,
    family_code: row.family_code,
    family_label: row.family_label,
    procede: row.procede,
    designation_courte: row.designation_courte,
    designation_longue: row.designation_longue,
    synonymes: row.synonymes ?? [],
    statut: row.statut,
    current_revision: row.rev_json ? toRevisionSummary(mapRevision(row.rev_json)) : null,
    updated_at: row.updated_at,
    favori: row.favori === true,
    archived_at: row.archived_at,
    archive_reason: row.archive_reason,
  }));

  return { items, total, page: filters.page, page_size: filters.page_size };
}

/**
 * `viewerUserId` peut être `null` pour les relectures internes (après écriture)
 * qui n'ont pas de lecteur : le favori vaut alors `false` et n'est jamais
 * renvoyé au mauvais utilisateur.
 */
export async function repoGetFinish(
  finishId: string,
  viewerUserId: number | null = null
): Promise<SurfaceFinishDetail | null> {
  const res = await db.query<FinishRow & { favori: boolean }>(
    `SELECT ${FINISH_COLS}, (fav.user_id IS NOT NULL) AS favori
     FROM public.surface_finishes f
     LEFT JOIN public.surface_finish_families fam ON fam.code = f.family_code
     LEFT JOIN public.surface_finish_favorites fav
       ON fav.finish_id = f.id AND fav.user_id = $2::integer
     WHERE f.id = $1::uuid`,
    [finishId, viewerUserId]
  );
  const row = res.rows[0];
  if (!row) return null;

  const revisions = await db.query<RevisionRow>(
    `SELECT ${revisionColumns("r")} FROM public.surface_finish_revisions r
     WHERE r.finish_id = $1::uuid ORDER BY r.revision DESC`,
    [finishId]
  );
  const mapped = revisions.rows.map(mapRevision);
  const current =
    mapped.find((rev) => rev.id === row.current_revision_id) ?? mapped.find((rev) => rev.statut === "ACTIVE") ?? null;

  return {
    id: row.id,
    code: row.code,
    family_code: row.family_code,
    family_label: row.family_label,
    procede: row.procede,
    designation_courte: row.designation_courte,
    designation_longue: row.designation_longue,
    description: row.description,
    synonymes: row.synonymes ?? [],
    statut: row.statut,
    current_revision: current ? toRevisionSummary(current) : null,
    revisions: mapped,
    created_at: row.created_at,
    updated_at: row.updated_at,
    favori: row.favori === true,
    archived_at: row.archived_at,
    archive_reason: row.archive_reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Écriture — finitions                                                        */
/* -------------------------------------------------------------------------- */

export async function repoCreateFinishDraft(
  body: CreateFinishBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  const client = await db.connect();
  let finishId = "";
  try {
    await client.query("BEGIN");

    const family = await client.query(
      `SELECT 1 FROM public.surface_finish_families WHERE code = $1 AND is_active`,
      [body.family_code]
    );
    if (family.rowCount === 0) {
      throw new HttpError(422, "SURFACE_FINISH_FAMILY_UNKNOWN", "Famille de finition inconnue ou désactivée.");
    }

    // Le code visible est alloué par le SERVEUR, jamais proposé par l'interface.
    const code = await generateSurfaceFinishCode(client);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.surface_finishes
         (code, family_code, procede, designation_courte, designation_longue, description, synonymes, statut, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'BROUILLON',$8,$8)
       RETURNING id::text AS id`,
      [
        code,
        body.family_code,
        body.procede,
        body.designation_courte,
        body.designation_longue,
        body.description,
        body.synonymes,
        audit.user_id,
      ]
    );
    finishId = inserted.rows[0].id;

    // Toute finition naît avec sa révision 1 en brouillon : une finition sans
    // révision ne veut rien dire techniquement.
    const revision = await client.query<{ id: string }>(
      `INSERT INTO public.surface_finish_revisions (finish_id, revision, statut, created_by, updated_by)
       VALUES ($1::uuid, 1, 'BROUILLON', $2, $2)
       RETURNING id::text AS id`,
      [finishId, audit.user_id]
    );

    await client.query(`UPDATE public.surface_finishes SET current_revision_id = $2::uuid WHERE id = $1::uuid`, [
      finishId,
      revision.rows[0].id,
    ]);

    await insertFinishAudit(client, audit, "finitions.create", "surface_finish", finishId, {
      code,
      family_code: body.family_code,
      procede: body.procede,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // #226 — `surface_finishes_identity_uq` (même famille + même procédé +
    // même désignation normalisée, hors archives) rend le doublon strict
    // impossible EN BASE. Sans cette traduction, deux créations concurrentes
    // rendraient un 500 illisible au lieu d'un conflit exploitable.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new HttpError(
        409,
        "SURFACE_FINISH_DUPLICATE",
        "Une finition active porte déjà cette famille, ce procédé et cette désignation. Ouvrez-la, ou changez la désignation."
      );
    }
    throw err;
  } finally {
    client.release();
  }

  // Relecture APRÈS le commit : lire par le pool depuis une transaction ouverte
  // ne verrait rien (leçon du chantier GED).
  const out = await repoGetFinish(finishId, audit.user_id);
  if (!out) throw new Error("Failed to read created finish");
  return out;
}

export async function repoUpdateFinishDraft(
  finishId: string,
  body: UpdateFinishBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ statut: SurfaceFinishStatus; updated_at: string }>(
      `SELECT statut, updated_at::text AS updated_at FROM public.surface_finishes WHERE id = $1::uuid FOR UPDATE`,
      [finishId]
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: "Cette finition",
    });
    if (current.statut === "ARCHIVEE") {
      throw new HttpError(409, "SURFACE_FINISH_ARCHIVED", "Une finition archivée ne se modifie plus.");
    }

    if (body.family_code !== undefined) {
      const family = await client.query(
        `SELECT 1 FROM public.surface_finish_families WHERE code = $1 AND is_active`,
        [body.family_code]
      );
      if (family.rowCount === 0) {
        throw new HttpError(422, "SURFACE_FINISH_FAMILY_UNKNOWN", "Famille de finition inconnue ou désactivée.");
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.family_code !== undefined) push("family_code", body.family_code);
    if (body.procede !== undefined) push("procede", body.procede);
    if (body.designation_courte !== undefined) push("designation_courte", body.designation_courte);
    if (body.designation_longue !== undefined) push("designation_longue", body.designation_longue);
    if (body.description !== undefined) push("description", body.description);
    if (body.synonymes !== undefined) push("synonymes", body.synonymes);
    values.push(audit.user_id);
    sets.push(`updated_by = $${values.length}`);
    sets.push(`updated_at = now()`);
    values.push(finishId);

    await client.query(`UPDATE public.surface_finishes SET ${sets.join(", ")} WHERE id = $${values.length}::uuid`, values);
    await insertFinishAudit(client, audit, "finitions.update", "surface_finish", finishId, {
      changed: Object.keys(body).filter((key) => key !== "expected_updated_at"),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Renommer une finition peut la faire entrer en collision avec une autre :
    // même index, même traduction que pour la création.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new HttpError(
        409,
        "SURFACE_FINISH_DUPLICATE",
        "Une autre finition active porte déjà cette famille, ce procédé et cette désignation."
      );
    }
    throw err;
  } finally {
    client.release();
  }

  const out = await repoGetFinish(finishId, audit.user_id);
  if (!out) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Écriture — révisions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ordre AUTORITAIRE des colonnes écrites d'une révision : la liste et les
 * paramètres sont dérivés du MÊME tableau, il ne peut pas y avoir de décalage.
 */
const REVISION_WRITE_FIELDS = [
  "norme",
  "reference_client",
  "classe",
  "substrat",
  "epaisseur_min",
  "epaisseur_nominale",
  "epaisseur_max",
  "epaisseur_unite",
  "couleur",
  "teinte_ral",
  "aspect",
  "brillance",
  "rugosite",
  "durete",
  "exigence_corrosion",
  "pretraitement",
  "posttraitement",
  "zones_defaut",
  "regles_masquage",
  "criteres_acceptation",
  "controles",
  "certificat_requis",
  "certificat_type",
  "conditionnement_retour",
  "unite_achat",
  "designation_template",
  "commentaire_template",
  "date_effet",
] as const;

function revisionWriteValues(payload: RevisionPayloadDTO): unknown[] {
  const map: Record<(typeof REVISION_WRITE_FIELDS)[number], unknown> = {
    norme: payload.norme,
    reference_client: payload.reference_client,
    classe: payload.classe,
    substrat: payload.substrat,
    epaisseur_min: payload.epaisseur_min,
    epaisseur_nominale: payload.epaisseur_nominale,
    epaisseur_max: payload.epaisseur_max,
    epaisseur_unite: payload.epaisseur_unite ?? "um",
    couleur: payload.couleur,
    teinte_ral: payload.teinte_ral,
    aspect: payload.aspect,
    brillance: payload.brillance,
    rugosite: payload.rugosite,
    durete: payload.durete,
    exigence_corrosion: payload.exigence_corrosion,
    pretraitement: payload.pretraitement,
    posttraitement: payload.posttraitement,
    zones_defaut: payload.zones_defaut,
    regles_masquage: payload.regles_masquage,
    criteres_acceptation: payload.criteres_acceptation ?? null,
    controles: payload.controles,
    certificat_requis: payload.certificat_requis ?? false,
    certificat_type: payload.certificat_type,
    conditionnement_retour: payload.conditionnement_retour,
    unite_achat: payload.unite_achat ?? "PCE",
    designation_template: payload.designation_template,
    commentaire_template: payload.commentaire_template,
    date_effet: payload.date_effet,
  };
  return REVISION_WRITE_FIELDS.map((field) => map[field]);
}

function assertRevisionPayloadCoherent(payload: RevisionPayloadDTO): void {
  const unit = normalizeThicknessUnit(payload.epaisseur_unite ?? "um");
  assertThicknessCoherent({
    min_um: thicknessToMicrometers(payload.epaisseur_min, unit),
    nominal_um: thicknessToMicrometers(payload.epaisseur_nominale, unit),
    max_um: thicknessToMicrometers(payload.epaisseur_max, unit),
  });
  if (payload.certificat_requis && !payload.certificat_type) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_CERTIFICATE_TYPE_REQUIRED",
      "Un certificat exigé sans type est une exigence incomplète."
    );
  }
  if (payload.commentaire_template) assertTemplateVariablesAllowed(payload.commentaire_template);
  if (payload.designation_template) assertTemplateVariablesAllowed(payload.designation_template);
}

/**
 * Crée la révision suivante. Une modification technique majeure NE réécrit
 * jamais une révision publiée : elle en crée une nouvelle, et la précédente
 * reste lisible dans l'historique.
 */
export async function repoCreateRevision(
  finishId: string,
  payload: RevisionPayloadDTO,
  audit: AuditContext
): Promise<SurfaceFinishRevisionDetail> {
  assertRevisionPayloadCoherent(payload);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Le verrou est posé sur la finition PARENTE : un agrégat ne supporte pas
    // `FOR UPDATE`, et c'est bien la finition qui sérialise ses révisions.
    const finish = await client.query<{ id: string; statut: SurfaceFinishStatus }>(
      `SELECT id::text AS id, statut FROM public.surface_finishes WHERE id = $1::uuid FOR UPDATE`,
      [finishId]
    );
    if (finish.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");
    if (finish.rows[0].statut === "ARCHIVEE") {
      throw new HttpError(409, "SURFACE_FINISH_ARCHIVED", "Une finition archivée n'accepte plus de révision.");
    }

    const next = await client.query<{ next_revision: number }>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
       FROM public.surface_finish_revisions WHERE finish_id = $1::uuid`,
      [finishId]
    );
    const nextRevision = next.rows[0]?.next_revision ?? 1;

    const params = revisionWriteValues(payload);
    const placeholders = params.map((_, index) => `$${index + 3}`).join(", ");
    const inserted = await client.query<RevisionRow>(
      `INSERT INTO public.surface_finish_revisions
         (finish_id, revision, ${REVISION_WRITE_FIELDS.join(", ")}, statut, created_by, updated_by)
       VALUES ($1::uuid, $2, ${placeholders}, 'BROUILLON', $${params.length + 3}, $${params.length + 3})
       RETURNING ${revisionColumns("")}`,
      [finishId, nextRevision, ...params, audit.user_id]
    );

    const row = inserted.rows[0];
    await insertFinishAudit(client, audit, "finitions.revision.create", "surface_finish_revision", row.id, {
      finish_id: finishId,
      revision: nextRevision,
    });
    await client.query("COMMIT");
    return mapRevision(row);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateRevision(
  revisionId: string,
  body: UpdateRevisionBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishRevisionDetail> {
  assertRevisionPayloadCoherent(body);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ statut: SurfaceFinishStatus; updated_at: string; finish_id: string }>(
      `SELECT statut, updated_at::text AS updated_at, finish_id::text AS finish_id
       FROM public.surface_finish_revisions WHERE id = $1::uuid FOR UPDATE`,
      [revisionId]
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Révision introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: "Cette révision",
    });
    assertRevisionContentMutable(current.statut);

    const params = revisionWriteValues(body);
    const assignments = REVISION_WRITE_FIELDS.map((col, index) => `${col} = $${index + 2}`).join(", ");

    const updated = await client.query<RevisionRow>(
      `UPDATE public.surface_finish_revisions
       SET ${assignments}, updated_by = $${params.length + 2}, updated_at = now()
       WHERE id = $1::uuid
       RETURNING ${revisionColumns("")}`,
      [revisionId, ...params, audit.user_id]
    );
    const row = updated.rows[0];
    await insertFinishAudit(client, audit, "finitions.revision.update", "surface_finish_revision", revisionId, {
      finish_id: current.finish_id,
    });
    await client.query("COMMIT");
    return mapRevision(row);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type RevisionImpact = {
  gammes: number;
  articles: number;
  operations: Array<{ gamme_id: string; operation_id: string; piece_code: string; indice: string }>;
};

/** Analyse d'impact AVANT suspension/obsolescence. Aucune action automatique. */
export async function repoRevisionImpact(revisionId: string): Promise<RevisionImpact> {
  const usage = await db.query<{ gamme_id: string; operation_id: string; piece_code: string; indice: string }>(
    `SELECT
       f.gamme_id::text           AS gamme_id,
       f.gamme_operation_id::text AS operation_id,
       pt.code_piece              AS piece_code,
       ptv.indice                 AS indice
     FROM public.gamme_operation_finitions f
     JOIN public.piece_technique_versions ptv ON ptv.id = f.piece_technique_version_id
     JOIN public.pieces_techniques pt ON pt.id = ptv.piece_technique_id
     WHERE f.finish_revision_id = $1::uuid
     ORDER BY pt.code_piece, ptv.indice
     LIMIT 500`,
    [revisionId]
  );
  const articles = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.articles_traitement WHERE finish_revision_id = $1::uuid`,
    [revisionId]
  );
  return {
    gammes: new Set(usage.rows.map((row) => row.gamme_id)).size,
    articles: articles.rows[0]?.total ?? 0,
    operations: usage.rows,
  };
}

export async function repoTransitionRevision(
  revisionId: string,
  body: TransitionRevisionBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishRevisionDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ statut: SurfaceFinishStatus; updated_at: string; finish_id: string }>(
      `SELECT statut, updated_at::text AS updated_at, finish_id::text AS finish_id
       FROM public.surface_finish_revisions WHERE id = $1::uuid FOR UPDATE`,
      [revisionId]
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Révision introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: "Cette révision",
    });
    assertSurfaceFinishTransition(current.statut, body.statut);

    // Publier une révision rend obsolète celle qu'elle remplace : l'index
    // partiel n'accepte qu'une seule révision ACTIVE par finition.
    if (body.statut === "ACTIVE") {
      await client.query(
        `UPDATE public.surface_finish_revisions
         SET statut = 'OBSOLETE', updated_at = now(), updated_by = $3
         WHERE finish_id = $1::uuid AND statut = 'ACTIVE' AND id <> $2::uuid`,
        [current.finish_id, revisionId, audit.user_id]
      );
    }

    const approving = body.statut === "ACTIVE";
    const updated = await client.query<RevisionRow>(
      `UPDATE public.surface_finish_revisions
       SET statut = $2,
           approbateur_user_id = CASE WHEN $3::boolean THEN $4::integer ELSE approbateur_user_id END,
           approved_at = CASE WHEN $3::boolean THEN now() ELSE approved_at END,
           updated_by = $4::integer,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING ${revisionColumns("")}`,
      [revisionId, body.statut, approving, audit.user_id]
    );

    if (approving) {
      await client.query(
        `UPDATE public.surface_finishes
         SET current_revision_id = $2::uuid,
             statut = CASE WHEN statut IN ('BROUILLON','EN_VALIDATION') THEN 'ACTIVE' ELSE statut END,
             updated_at = now(), updated_by = $3
         WHERE id = $1::uuid`,
        [current.finish_id, revisionId, audit.user_id]
      );
    }

    await insertFinishAudit(client, audit, "finitions.revision.transition", "surface_finish_revision", revisionId, {
      finish_id: current.finish_id,
      from: current.statut,
      to: body.statut,
      motif: body.motif,
    });

    await client.query("COMMIT");
    return mapRevision(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

const DOCUMENT_COLS = `
  id::text AS id, revision_id::text AS revision_id, libelle, doc_type,
  ged_document_id::text AS ged_document_id, reference_externe, sha256,
  created_at::text AS created_at
`;

export async function repoListRevisionDocuments(revisionId: string): Promise<SurfaceFinishDocument[]> {
  const res = await db.query<SurfaceFinishDocument>(
    `SELECT ${DOCUMENT_COLS}
     FROM public.surface_finish_revision_documents
     WHERE revision_id = $1::uuid
     ORDER BY created_at`,
    [revisionId]
  );
  return res.rows;
}

export async function repoAttachRevisionDocument(
  revisionId: string,
  body: AttachDocumentBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDocument> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const rev = await client.query<{ statut: SurfaceFinishStatus }>(
      `SELECT statut FROM public.surface_finish_revisions WHERE id = $1::uuid FOR UPDATE`,
      [revisionId]
    );
    if (rev.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Révision introuvable.");
    assertRevisionContentMutable(rev.rows[0].statut);

    const inserted = await client.query<SurfaceFinishDocument>(
      `INSERT INTO public.surface_finish_revision_documents
         (revision_id, libelle, doc_type, ged_document_id, reference_externe, sha256, created_by)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7)
       RETURNING ${DOCUMENT_COLS}`,
      [revisionId, body.libelle, body.doc_type, body.ged_document_id, body.reference_externe, body.sha256, audit.user_id]
    );
    await insertFinishAudit(client, audit, "finitions.revision.document.attach", "surface_finish_revision", revisionId, {
      libelle: body.libelle,
      doc_type: body.doc_type,
    });
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
