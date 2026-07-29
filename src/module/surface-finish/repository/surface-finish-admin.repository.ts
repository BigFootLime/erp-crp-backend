// #226 — Administration de la bibliothèque : favoris, archivage, historique et
// contrôle des doublons.
//
// Séparé de `surface-finish-library.repository.ts` (déjà 900 lignes) parce que
// ce sont d'autres actes : la lecture/écriture d'une définition technique d'un
// côté, la gestion du référentiel de l'autre.

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  assertFinishArchivable,
  assertFinishReactivable,
  assertOptimisticVersion,
  classifySimilarity,
  SIMILARITY_FLOOR,
  statusAfterReactivation,
  type SurfaceFinishStatus,
} from "../domain/surface-finish-policy";
import type {
  ArchiveFinishBodyDTO,
  FinishHistoryQueryDTO,
  ReactivateFinishBodyDTO,
  SimilarFinishesQueryDTO,
} from "../validators/surface-finish.validators";
import type {
  SurfaceFinishDetail,
  SurfaceFinishHistoryEntry,
  SurfaceFinishSimilarMatch,
} from "../types/surface-finish.types";
import {
  insertFinishAudit,
  mapRevision,
  repoGetFinish,
  revisionColumns,
  toRevisionSummary,
  type RevisionRow,
} from "./surface-finish-library.repository";

/* -------------------------------------------------------------------------- */
/* Favoris                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Poser/retirer un favori est idempotent par construction : `ON CONFLICT DO
 * NOTHING` et un `DELETE` qui ne trouve rien ne sont pas des erreurs. Un
 * double-clic sur l'étoile ne doit jamais produire un 409.
 *
 * Pas d'audit ici, délibérément : un favori n'engage rien et journaliser chaque
 * clic d'étoile noierait `erp_audit_logs`, qui sert à retracer des actes
 * opposables.
 */
export async function repoSetFinishFavorite(
  finishId: string,
  userId: number,
  favorite: boolean
): Promise<{ finish_id: string; favori: boolean }> {
  const exists = await db.query(`SELECT 1 FROM public.surface_finishes WHERE id = $1::uuid`, [finishId]);
  if (exists.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");

  if (favorite) {
    await db.query(
      `INSERT INTO public.surface_finish_favorites (user_id, finish_id)
       VALUES ($1::integer, $2::uuid)
       ON CONFLICT (user_id, finish_id) DO NOTHING`,
      [userId, finishId]
    );
  } else {
    await db.query(`DELETE FROM public.surface_finish_favorites WHERE user_id = $1::integer AND finish_id = $2::uuid`, [
      userId,
      finishId,
    ]);
  }

  return { finish_id: finishId, favori: favorite };
}

/* -------------------------------------------------------------------------- */
/* Archivage                                                                   */
/* -------------------------------------------------------------------------- */

type FinishLockRow = { id: string; statut: SurfaceFinishStatus; updated_at: string; code: string };

/**
 * Archiver une finition la sort du référentiel SANS toucher à ce que les gammes
 * ont déjà figé : une exigence de gamme conserve sa `finish_revision_id` et un
 * article validé garde sa spécification. C'est tout l'intérêt du modèle
 * versionné d'ADR-0038 — archiver n'est pas réécrire l'histoire.
 *
 * En revanche on REFUSE d'archiver une finition encore utilisée par une gamme
 * modifiable : là, l'archivage serait subi par quelqu'un qui est en train de
 * travailler dessus. Les gammes APPLICABLE, elles, n'empêchent rien : elles
 * sont figées et leur exigence reste lisible.
 */
export async function repoArchiveFinish(
  finishId: string,
  body: ArchiveFinishBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query<FinishLockRow>(
      `SELECT id::text AS id, statut, updated_at::text AS updated_at, code
       FROM public.surface_finishes WHERE id = $1::uuid FOR UPDATE`,
      [finishId]
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");

    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: "Cette finition",
    });
    assertFinishArchivable(current.statut);

    const blocking = await client.query<{ gamme_id: string; piece_code: string; indice: string; gamme_statut: string }>(
      `SELECT DISTINCT
         gof.gamme_id::text AS gamme_id,
         COALESCE(pt.code_piece, '?') AS piece_code,
         COALESCE(ptv.indice, '?')    AS indice,
         g.statut                     AS gamme_statut
       FROM public.gamme_operation_finitions gof
       JOIN public.surface_finish_revisions sfr ON sfr.id = gof.finish_revision_id
       JOIN public.gammes g ON g.id = gof.gamme_id
       LEFT JOIN public.piece_technique_versions ptv ON ptv.id = gof.piece_technique_version_id
       LEFT JOIN public.pieces_techniques pt ON pt.id = ptv.piece_technique_id
       WHERE sfr.finish_id = $1::uuid
         AND g.statut IN ('BROUILLON','EN_VALIDATION')
       LIMIT 20`,
      [finishId]
    );

    if (blocking.rowCount && blocking.rowCount > 0) {
      throw new HttpError(
        409,
        "SURFACE_FINISH_IN_USE",
        `Cette finition est utilisée par ${blocking.rowCount} gamme(s) encore modifiable(s). Retirez-la de ces gammes avant de l'archiver.`,
        { gammes: blocking.rows }
      );
    }

    await client.query(
      `UPDATE public.surface_finishes
       SET statut = 'ARCHIVEE',
           archived_at = now(),
           archived_by = $2::integer,
           archive_reason = $3,
           statut_changed_at = now(),
           statut_changed_by = $2::integer,
           updated_at = now(),
           updated_by = $2::integer
       WHERE id = $1::uuid`,
      [finishId, audit.user_id, body.motif]
    );

    await insertFinishAudit(client, audit, "finitions.archive", "surface_finish", finishId, {
      code: current.code,
      from: current.statut,
      to: "ARCHIVEE",
      motif: body.motif,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Relecture APRÈS le commit (leçon GED : lire par le pool depuis une
  // transaction ouverte ne verrait rien).
  const out = await repoGetFinish(finishId, audit.user_id);
  if (!out) throw new Error("Failed to read archived finish");
  return out;
}

/**
 * Sortir d'archive. Le statut n'est pas « restauré » : il est RECALCULÉ depuis
 * les révisions, seule chose qui fasse foi. La désarchivage peut échouer en
 * `23505` si une autre finition a repris l'identité libérée entre-temps — c'est
 * le comportement voulu, traduit en 409 lisible.
 */
export async function repoReactivateFinish(
  finishId: string,
  body: ReactivateFinishBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query<FinishLockRow>(
      `SELECT id::text AS id, statut, updated_at::text AS updated_at, code
       FROM public.surface_finishes WHERE id = $1::uuid FOR UPDATE`,
      [finishId]
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");

    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: "Cette finition",
    });
    assertFinishReactivable(current.statut);

    const active = await client.query(
      `SELECT 1 FROM public.surface_finish_revisions WHERE finish_id = $1::uuid AND statut = 'ACTIVE' LIMIT 1`,
      [finishId]
    );
    const nextStatus = statusAfterReactivation((active.rowCount ?? 0) > 0);

    try {
      await client.query(
        `UPDATE public.surface_finishes
         SET statut = $2,
             archived_at = NULL,
             archived_by = NULL,
             archive_reason = NULL,
             statut_changed_at = now(),
             statut_changed_by = $3::integer,
             updated_at = now(),
             updated_by = $3::integer
         WHERE id = $1::uuid`,
        [finishId, nextStatus, audit.user_id]
      );
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new HttpError(
          409,
          "SURFACE_FINISH_IDENTITY_TAKEN",
          "Une autre finition active porte désormais la même famille, le même procédé et la même désignation. Renommez-la avant de sortir celle-ci d'archive."
        );
      }
      throw err;
    }

    await insertFinishAudit(client, audit, "finitions.reactivate", "surface_finish", finishId, {
      code: current.code,
      from: "ARCHIVEE",
      to: nextStatus,
      motif: body.motif,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const out = await repoGetFinish(finishId, audit.user_id);
  if (!out) throw new Error("Failed to read reactivated finish");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Historique                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * L'historique est LU depuis `erp_audit_logs`, jamais reconstitué à partir des
 * `updated_at` : une reconstitution inventerait des évènements qui n'ont pas eu
 * lieu. Une finition sans trace affiche une liste vide — c'est une information,
 * pas un bug.
 *
 * La finition ET ses révisions sont couvertes : l'utilisateur veut « ce qui est
 * arrivé à cette finition », pas « ce qui est arrivé à cette ligne de table ».
 */
export async function repoListFinishHistory(
  finishId: string,
  query: FinishHistoryQueryDTO
): Promise<SurfaceFinishHistoryEntry[]> {
  const exists = await db.query(`SELECT 1 FROM public.surface_finishes WHERE id = $1::uuid`, [finishId]);
  if (exists.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");

  const values: unknown[] = [finishId];
  let beforeSql = "";
  if (query.before_id !== undefined) {
    values.push(query.before_id);
    beforeSql = `AND l.id < $${values.length}`;
  }
  values.push(query.limit);

  const res = await db.query<{
    id: string;
    created_at: string;
    action: string;
    entity_type: string;
    entity_id: string;
    user_id: number | null;
    user_label: string | null;
    details: Record<string, unknown> | null;
  }>(
    `SELECT
       l.id::text AS id,
       l.created_at::text AS created_at,
       l.action,
       l.entity_type,
       l.entity_id,
       l.user_id,
       -- Nom d'usage seulement. L'e-mail n'a rien à faire dans un historique
       -- affiché à l'écran (RGPD : minimisation).
       COALESCE(NULLIF(btrim(u.name), ''), u.username) AS user_label,
       l.details
     FROM public.erp_audit_logs l
     LEFT JOIN public.users u ON u.id = l.user_id
     WHERE (
        (l.entity_type = 'surface_finish' AND l.entity_id = $1::text)
        OR (l.entity_type IN ('surface_finish_revision', 'surface_finish_document')
            AND l.entity_id IN (
              SELECT r.id::text FROM public.surface_finish_revisions r WHERE r.finish_id = $1::uuid
            ))
        OR (l.entity_type = 'surface_finish_revision'
            AND l.details ->> 'finish_id' = $1::text)
     )
     ${beforeSql}
     ORDER BY l.id DESC
     LIMIT $${values.length}`,
    values
  );

  // `erp_audit_logs.id` est un bigint : le driver le rend en chaîne. Le
  // convertir ici évite un identifiant qui « saute » côté navigateur.
  return res.rows.map((row) => ({
    id: Number(row.id),
    created_at: row.created_at,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    user_id: row.user_id,
    user_label: row.user_label,
    details: row.details,
  }));
}

/* -------------------------------------------------------------------------- */
/* Contrôle des doublons                                                       */
/* -------------------------------------------------------------------------- */

type SimilarRow = {
  id: string;
  code: string;
  family_code: string;
  family_label: string | null;
  procede: string;
  designation_courte: string;
  designation_longue: string | null;
  synonymes: string[] | null;
  statut: SurfaceFinishStatus;
  score: string | number;
  exact_identity: boolean;
  same_family: boolean;
  synonym_hit: boolean;
  norme_hit: boolean;
  couleur_hit: boolean;
  epaisseur_hit: boolean;
  rev_json: RevisionRow | null;
};

/**
 * Cherche les finitions proches d'une saisie en cours. CONSULTATIF : ne bloque
 * jamais, ne crée rien. L'index unique `surface_finishes_identity_uq` reste la
 * seule barrière dure.
 *
 * Le score combine la désignation et le procédé via `similarity()` (pg_trgm,
 * qui fonctionne sans index à cette volumétrie — cf. patch #226), et retient
 * le meilleur des deux plutôt que leur moyenne : « anodisation noire » et
 * « anodisation dure noire » se ressemblent par la désignation même quand les
 * procédés diffèrent, et il faut le montrer.
 *
 * Les archives SONT incluses : « cette finition existe déjà mais elle a été
 * archivée en mars pour telle raison » est exactement ce qu'il faut savoir
 * avant d'en recréer une.
 */
export async function repoFindSimilarFinishes(query: SimilarFinishesQueryDTO): Promise<SurfaceFinishSimilarMatch[]> {
  const designation = query.designation_courte ?? "";
  const procede = query.procede ?? "";

  // Sans désignation ni procédé ni synonyme, il n'y a rien à comparer : une
  // recherche vide renverrait la bibliothèque entière classée au hasard.
  if (designation.trim() === "" && procede.trim() === "" && query.synonymes.length === 0) return [];

  const res = await db.query<SimilarRow>(
    `WITH candidat AS (
       SELECT
         f.id, f.code, f.family_code, f.procede, f.designation_courte,
         f.designation_longue, f.synonymes, f.statut,
         fam.label AS family_label,
         GREATEST(
           similarity(public.surface_finish_norm(f.designation_courte), public.surface_finish_norm($1)),
           similarity(public.surface_finish_norm(f.procede), public.surface_finish_norm($2))
         ) AS base_score,
         (
           $3::text IS NOT NULL
           AND f.family_code = $3::text
           AND public.surface_finish_norm(f.procede) = public.surface_finish_norm($2)
           AND public.surface_finish_norm(f.designation_courte) = public.surface_finish_norm($1)
         ) AS exact_identity,
         ($3::text IS NOT NULL AND f.family_code = $3::text) AS same_family,
         EXISTS (
           SELECT 1 FROM unnest(f.synonymes) AS s(value)
           JOIN unnest($4::text[]) AS q(value) ON true
           WHERE public.surface_finish_norm(s.value) = public.surface_finish_norm(q.value)
              OR public.surface_finish_norm(s.value) = public.surface_finish_norm($1)
         ) AS synonym_hit
       FROM public.surface_finishes f
       LEFT JOIN public.surface_finish_families fam ON fam.code = f.family_code
       WHERE ($5::uuid IS NULL OR f.id <> $5::uuid)
     )
     SELECT
       c.id::text AS id, c.code, c.family_code, c.family_label, c.procede,
       c.designation_courte, c.designation_longue, c.synonymes, c.statut,
       c.exact_identity, c.same_family, c.synonym_hit,
       -- Appartenir à la même famille rapproche réellement deux entrées ; un
       -- synonyme commun est un aveu de doublon. Le score reste plafonné à 1.
       LEAST(
         1.0,
         c.base_score
         + CASE WHEN c.same_family THEN 0.15 ELSE 0 END
         + CASE WHEN c.synonym_hit THEN 0.25 ELSE 0 END
       )::numeric AS score,
       ($6::text IS NOT NULL AND public.surface_finish_norm(rev.norme) = public.surface_finish_norm($6)) AS norme_hit,
       ($7::text IS NOT NULL AND (
          public.surface_finish_norm(rev.couleur)   = public.surface_finish_norm($7)
          OR public.surface_finish_norm(rev.teinte_ral) = public.surface_finish_norm($7)
       )) AS couleur_hit,
       ($8::numeric IS NOT NULL AND rev.id IS NOT NULL AND
          $8::numeric BETWEEN COALESCE(public.surface_finish_to_um(rev.epaisseur_min::numeric, rev.epaisseur_unite), 0)
                          AND COALESCE(public.surface_finish_to_um(rev.epaisseur_max::numeric, rev.epaisseur_unite), 1e12)
       ) AS epaisseur_hit,
       CASE WHEN rev.id IS NULL THEN NULL ELSE to_jsonb(rev) END AS rev_json
     FROM candidat c
     LEFT JOIN LATERAL (
       SELECT ${revisionColumns("r")}
       FROM public.surface_finish_revisions r
       WHERE r.finish_id = c.id
       ORDER BY (r.statut = 'ACTIVE') DESC, r.revision DESC
       LIMIT 1
     ) rev ON true
     WHERE c.exact_identity OR c.synonym_hit OR c.base_score >= $9::real
     ORDER BY c.exact_identity DESC, score DESC, c.designation_courte
     LIMIT $10`,
    [
      designation,
      procede,
      query.family_code,
      query.synonymes,
      query.exclude_finish_id,
      query.norme,
      query.couleur,
      query.epaisseur_um,
      SIMILARITY_FLOOR,
      query.limit,
    ]
  );

  const out: SurfaceFinishSimilarMatch[] = [];
  for (const row of res.rows) {
    const score = typeof row.score === "string" ? Number(row.score) : row.score;
    const level = classifySimilarity(score, row.exact_identity === true);
    // `classifySimilarity` peut écarter ce que le SQL a laissé passer (un
    // synonyme commun sur un libellé sans rapport) : la politique tranche.
    if (!level) continue;

    const reasons: string[] = [];
    if (row.exact_identity) reasons.push("Même famille, même procédé, même désignation");
    if (row.synonym_hit) reasons.push("Synonyme en commun");
    if (row.same_family && !row.exact_identity) reasons.push("Même famille");
    if (row.norme_hit) reasons.push("Même norme");
    if (row.couleur_hit) reasons.push("Même couleur");
    if (row.epaisseur_hit) reasons.push("Épaisseur compatible");

    out.push({
      id: row.id,
      code: row.code,
      family_code: row.family_code,
      family_label: row.family_label,
      procede: row.procede,
      designation_courte: row.designation_courte,
      designation_longue: row.designation_longue,
      synonymes: row.synonymes ?? [],
      statut: row.statut,
      score: Math.round(score * 1000) / 1000,
      level,
      reasons,
      current_revision: row.rev_json ? toRevisionSummary(mapRevision(row.rev_json)) : null,
    });
  }
  return out;
}
