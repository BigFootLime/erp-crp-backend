// Accès données du chantier « OF, versioning, replanification, AR, document » (#370).
//
// Toute écriture passe par `withOfTransaction` : révision, proposition, version de
// planning, dossier d'AR et document sont écrits avec leur audit dans la MÊME
// transaction. Un audit écrit après coup, hors transaction, mentirait dès le
// premier rollback.
//
// ANTI-IDOR — principe appliqué partout ici : une ressource imbriquée n'est jamais
// lue par son seul identifiant. Elle est lue par (identifiant, of_id), l'OF venant
// du chemin de la requête et ayant déjà été autorisé. Un UUID de révision deviné
// sur un autre OF ne renvoie donc rien du tout, au lieu de renvoyer la donnée d'un
// autre dossier.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { MachineFamilyRef, OfRevisionOperation } from "../domain/of-revision";
import type { OfPlanningPayload, OfPlanningStatut } from "../domain/of-planning-version";
import type { NotificationRoutingRule } from "../../../shared/notifications/routing";

export type DbQueryer = Pick<PoolClient, "query">;

export class OfCommitUncertainError<T> extends HttpError {
  readonly transactionResult: T;
  readonly originalError: unknown;

  constructor(transactionResult: T, originalError: unknown) {
    super(
      503,
      "OF_COMMIT_UNCERTAIN",
      "Le résultat du COMMIT de l'ordre de fabrication doit être rapproché."
    );
    this.name = "OfCommitUncertainError";
    this.transactionResult = transactionResult;
    this.originalError = originalError;
  }
}

export class OfRollbackUncertainError extends HttpError {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      503,
      "OF_ROLLBACK_UNCERTAIN",
      "Le rollback de l'ordre de fabrication n'a pas pu être confirmé."
    );
    this.name = "OfRollbackUncertainError";
    this.originalError = originalError;
  }
}

export type OfTransactionHooks = Readonly<{
  afterConfirmedRollback?: () => void | Promise<void>;
  afterRollbackUncertain?: () => void | Promise<void>;
}>;

/**
 * Transaction bornée. Aucune commande n'est envoyée sur un client ayant perdu
 * l'ACK de COMMIT : cette session est détruite et seul un rapprochement frais
 * par l'appelant peut décider entre succès, compensation ou préservation.
 */
export async function withOfTransaction<T>(
  fn: (tx: PoolClient) => Promise<T>,
  hooks: OfTransactionHooks = {}
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };

  try {
    await client.query("BEGIN");
  } catch (error) {
    release(true);
    throw error;
  }

  let result: T;
  try {
    result = await fn(client);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      release(true);
      await hooks.afterRollbackUncertain?.();
      throw new OfRollbackUncertainError(error);
    }
    // Release the rolled-back writer before compensation obtains a fresh
    // connection and the transaction-scoped GED SHA lock.
    release();
    await hooks.afterConfirmedRollback?.();
    throw error;
  }

  try {
    await client.query("COMMIT");
  } catch (error) {
    release(true);
    throw new OfCommitUncertainError(result, error);
  }
  release();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Référentiel des familles machine                                           */
/* -------------------------------------------------------------------------- */

export async function readMachineFamilies(tx: DbQueryer = pool): Promise<MachineFamilyRef[]> {
  const res = await tx.query(
    `SELECT code, libelle, programme_requis, ordre_affichage, actif
       FROM public.production_machine_families
      ORDER BY ordre_affichage, code`
  );
  return res.rows.map((row) => ({
    code: String(row.code),
    libelle: String(row.libelle),
    programmeRequis: Boolean(row.programme_requis),
    ordreAffichage: Number(row.ordre_affichage),
    actif: Boolean(row.actif),
  }));
}

/* -------------------------------------------------------------------------- */
/* En-tête d'OF — porte d'entrée de toute autorisation                         */
/* -------------------------------------------------------------------------- */

export type OfHeaderRow = {
  of_id: number;
  /** UUID immuable de l'OF, distinct du numéro métier. */
  of_uuid: string | null;
  numero: string;
  statut: string;
  quantite_lancee: number;
  affaire_id: number | null;
  commande_id: number | null;
  commande_ligne_id: number | null;
  client_id: string | null;
  client_nom: string | null;
  piece_technique_id: string | null;
  piece_reference: string | null;
  piece_designation: string | null;
  piece_indice: string | null;
  gamme_id: string | null;
  gamme_code: string | null;
  gamme_version: string | null;
  commande_numero: string | null;
  production_group_id: string | null;
  date_fin_prevue: string | null;
};

/**
 * Lit l'en-tête d'un OF, ou lève 404.
 *
 * C'est la seule fonction par laquelle un OF entre dans ce module : elle est le
 * point unique où un périmètre s'appliquerait.
 *
 * PÉRIMÈTRE SITE / ATELIER — état réel du modèle au 2026-07-29 : il n'existe
 * AUCUNE dimension de site dans le schéma. `users` ne porte ni site, ni atelier,
 * ni périmètre ; `production_group` est un regroupement pièce/client (0 ligne) et
 * non un site. Filtrer sur une colonne inexistante donnerait l'illusion d'une
 * cloison. Le périmètre réellement applicable et appliqué est donc l'isolation
 * INTER-OF (anti-IDOR) : voir les lectures `(id, of_id)` de ce fichier. Le jour où
 * le modèle portera un site, c'est ici — et ici seulement — qu'il se branche.
 */
export async function readOfHeader(ofId: number, tx: DbQueryer = pool): Promise<OfHeaderRow> {
  const res = await tx.query(
    // La gamme applicable se joint par la VERSION de pièce technique, pas par la
    // pièce : deux indices d'une même pièce ont deux gammes distinctes, et
    // joindre sur la pièce en ramènerait une au hasard.
    `SELECT o.id::int                        AS of_id,
            o.id::text                       AS of_uuid,
            o.numero,
            o.statut::text                   AS statut,
            o.quantite_lancee::float8        AS quantite_lancee,
            o.affaire_id::int                AS affaire_id,
            o.commande_id::int               AS commande_id,
            o.commande_ligne_id::int         AS commande_ligne_id,
            o.client_id::text                AS client_id,
            c.company_name                   AS client_nom,
            o.piece_technique_id::text       AS piece_technique_id,
            COALESCE(ptv.plan_reference, pt.code_piece) AS piece_reference,
            COALESCE(pt.designation, pt.name_piece)     AS piece_designation,
            ptv.indice                       AS piece_indice,
            g.id::text                       AS gamme_id,
            COALESCE(g.code, g.nom)          AS gamme_code,
            COALESCE(ptv.version_interne::text, ptv.indice) AS gamme_version,
            cc.numero                        AS commande_numero,
            o.production_group_id::text      AS production_group_id,
            o.date_fin_prevue::text          AS date_fin_prevue
       FROM public.ordres_fabrication o
       LEFT JOIN public.clients c            ON c.client_id = o.client_id
       LEFT JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
       LEFT JOIN public.piece_technique_versions ptv ON ptv.id = o.piece_technique_version_id
       LEFT JOIN public.gammes g
              ON g.piece_technique_version_id = o.piece_technique_version_id
             AND g.is_current = true
       LEFT JOIN public.commande_client cc   ON cc.id = o.commande_id
      WHERE o.id = $1`,
    [ofId]
  );

  const row = res.rows[0];
  if (!row) {
    throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable.");
  }
  return row as OfHeaderRow;
}

/* -------------------------------------------------------------------------- */
/* Révisions                                                                  */
/* -------------------------------------------------------------------------- */

export type OfRevisionRow = {
  id: string;
  of_id: number;
  revision_rank: number;
  revision_code: string;
  statut: string;
  snapshot: unknown;
  snapshot_sha256: string;
  diff: unknown;
  motif: string | null;
  author_user_id: number | null;
  author_label: string | null;
  created_at: string;
  activated_at: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
};

const REVISION_SELECT = `
  SELECT r.id::text            AS id,
         r.of_id::int          AS of_id,
         r.revision_rank::int  AS revision_rank,
         r.revision_code,
         r.statut,
         r.snapshot,
         r.snapshot_sha256,
         r.diff,
         r.motif,
         r.author_user_id::int AS author_user_id,
         u.username            AS author_label,
         r.created_at,
         r.activated_at,
         r.superseded_at,
         r.superseded_by::text AS superseded_by
    FROM public.of_revisions r
    LEFT JOIN public.users u ON u.id = r.author_user_id`;

export async function listRevisions(ofId: number, tx: DbQueryer = pool): Promise<OfRevisionRow[]> {
  const res = await tx.query(`${REVISION_SELECT} WHERE r.of_id = $1 ORDER BY r.revision_rank DESC`, [ofId]);
  return res.rows as OfRevisionRow[];
}

/** Lecture par (révision, OF) — un id d'une autre affaire ne renvoie rien. */
export async function getRevision(
  ofId: number,
  revisionId: string,
  tx: DbQueryer = pool
): Promise<OfRevisionRow | null> {
  const res = await tx.query(`${REVISION_SELECT} WHERE r.id = $1::uuid AND r.of_id = $2`, [revisionId, ofId]);
  return (res.rows[0] as OfRevisionRow | undefined) ?? null;
}

export async function getActiveRevision(
  ofId: number,
  tx: DbQueryer = pool
): Promise<OfRevisionRow | null> {
  const res = await tx.query(`${REVISION_SELECT} WHERE r.of_id = $1 AND r.statut = 'ACTIVE'`, [ofId]);
  return (res.rows[0] as OfRevisionRow | undefined) ?? null;
}

/**
 * Verrouille l'OF pour sérialiser deux révisions concurrentes.
 *
 * Sans ce verrou, deux requêtes simultanées liraient le même rang courant et
 * tenteraient toutes deux d'écrire la même `R01`. L'index unique partiel
 * `of_revisions_active_uq` en refuserait une, mais avec une erreur de contrainte
 * illisible ; le verrou transforme la course en attente puis en conflit explicite.
 */
export async function lockOf(tx: DbQueryer, ofId: number): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`of_revision:${ofId}`]);
}

export async function insertRevision(
  tx: DbQueryer,
  input: {
    ofId: number;
    rank: number;
    code: string;
    snapshot: unknown;
    snapshotSha256: string;
    diff: unknown;
    motif: string | null;
    authorUserId: number | null;
  }
): Promise<OfRevisionRow> {
  // La précédente devient OBSOLETE avant que la nouvelle ne devienne ACTIVE :
  // l'index unique partiel n'autorise qu'une seule ACTIVE à la fois.
  const previous = await tx.query(
    `UPDATE public.of_revisions
        SET statut = 'OBSOLETE', superseded_at = now()
      WHERE of_id = $1 AND statut = 'ACTIVE'
      RETURNING id::text AS id`,
    [input.ofId]
  );

  const res = await tx.query(
    `INSERT INTO public.of_revisions
       (of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256, diff, motif,
        author_user_id, activated_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb, $5, $6::jsonb, $7, $8, now())
     RETURNING id::text AS id`,
    [
      input.ofId,
      input.rank,
      input.code,
      JSON.stringify(input.snapshot),
      input.snapshotSha256,
      input.diff === undefined ? null : JSON.stringify(input.diff),
      input.motif,
      input.authorUserId,
    ]
  );

  const newId = String(res.rows[0].id);
  if (previous.rows[0]) {
    await tx.query(`UPDATE public.of_revisions SET superseded_by = $2::uuid WHERE id = $1::uuid`, [
      String(previous.rows[0].id),
      newId,
    ]);
  }

  const created = await getRevision(input.ofId, newId, tx);
  if (!created) throw new HttpError(500, "OF_REVISION_CREATE", "Révision introuvable après création.");
  return created;
}

/* -------------------------------------------------------------------------- */
/* Opérations d'une révision                                                  */
/* -------------------------------------------------------------------------- */

export type OfOperationRow = OfRevisionOperation & { id: string; revisionId: string };

export async function listOperations(
  ofId: number,
  revisionId: string,
  tx: DbQueryer = pool
): Promise<OfOperationRow[]> {
  const res = await tx.query(
    `SELECT op.id::text                            AS id,
            op.revision_id::text                   AS revision_id,
            op.phase::int                          AS phase,
            op.designation,
            op.machine_family_code                 AS family,
            op.machine_id::text                    AS machine_id,
            COALESCE(m.display_name, m.name, m.code) AS machine_label,
            op.numero_programme                    AS programme,
            op.tf_unit::float8                     AS temps_unitaire,
            op.tp::float8                          AS preparation,
            op.qte::float8                         AS quantite_base,
            op.coef::float8                        AS coefficient,
            op.cf_code_snapshot                    AS cf_code,
            op.cf_rate_id::text                    AS cf_rate_id,
            op.hourly_rate_applied::float8         AS taux_horaire,
            op.hourly_rate_source                  AS taux_horaire_source,
            op.hourly_rate_effective_at::text      AS taux_horaire_effective_at
       FROM public.of_operations op
       LEFT JOIN public.machines m ON m.id = op.machine_id
      WHERE op.of_id = $1 AND op.revision_id = $2::uuid
      ORDER BY op.phase`,
    [ofId, revisionId]
  );

  return res.rows.map((row) => ({
    id: String(row.id),
    revisionId: String(row.revision_id),
    phase: Number(row.phase),
    designation: String(row.designation),
    family: row.family === null ? null : String(row.family),
    machineId: row.machine_id === null ? null : String(row.machine_id),
    machineLabel: row.machine_label === null ? null : String(row.machine_label),
    programme: row.programme === null ? null : String(row.programme),
    tempsUnitaire: Number(row.temps_unitaire ?? 0),
    preparation: Number(row.preparation ?? 0),
    quantiteBase: Number(row.quantite_base ?? 0),
    coefficient: Number(row.coefficient ?? 1),
    cfCode: row.cf_code === null ? null : String(row.cf_code),
    cfRateId: row.cf_rate_id === null ? null : String(row.cf_rate_id),
    tauxHoraire: row.taux_horaire === null ? null : Number(row.taux_horaire),
    tauxHoraireSource: row.taux_horaire_source === null ? null : String(row.taux_horaire_source),
    tauxHoraireEffectiveAt:
      row.taux_horaire_effective_at === null ? null : String(row.taux_horaire_effective_at),
  }));
}

/**
 * Recopie les opérations d'une révision vers une autre.
 *
 * Les lignes sont INSÉRÉES, jamais mises à jour : c'est ce qui laisse les
 * pointages et les VISA de la révision précédente attachés à leurs propres
 * lignes. L'unicité `(of_id, revision_id, phase)` rend cette coexistence
 * possible ; avec l'ancienne clé `(of_id, phase)`, cet INSERT échouerait.
 */
export async function copyOperationsToRevision(
  tx: DbQueryer,
  args: { ofId: number; fromRevisionId: string; toRevisionId: string }
): Promise<number> {
  const res = await tx.query(
    `INSERT INTO public.of_operations (
        of_id, revision_id, phase, designation, cf_id, poste_id, machine_id,
        hourly_rate_applied, tp, tf_unit, qte, coef,
        temps_total_planned, temps_total_real, status,
        source_piece_operation_id, numero_programme, machine_family_code,
        cf_code_snapshot, cf_rate_id, temps_fabrication_planned,
        hourly_rate_source, hourly_rate_effective_at)
     SELECT of_id, $3::uuid, phase, designation, cf_id, poste_id, machine_id,
            hourly_rate_applied, tp, tf_unit, qte, coef,
            temps_total_planned, 0, 'A_FAIRE',
            source_piece_operation_id, numero_programme, machine_family_code,
            cf_code_snapshot, cf_rate_id, temps_fabrication_planned,
            hourly_rate_source, hourly_rate_effective_at
       FROM public.of_operations
      WHERE of_id = $1 AND revision_id = $2::uuid`,
    [args.ofId, args.fromRevisionId, args.toRevisionId]
  );
  return res.rowCount ?? 0;
}

/** Applique les modifications de phases sur la NOUVELLE révision uniquement. */
export async function updateOperationOnRevision(
  tx: DbQueryer,
  args: {
    ofId: number;
    revisionId: string;
    phase: number;
    designation?: string;
    family?: string | null;
    machineId?: string | null;
    programme?: string | null;
    tempsUnitaire?: number;
    preparation?: number;
    quantiteBase?: number;
    coefficient?: number;
  }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [args.ofId, args.revisionId, args.phase];
  const push = (fragment: string, value: unknown) => {
    values.push(value);
    sets.push(`${fragment} = $${values.length}`);
  };

  if (args.designation !== undefined) push("designation", args.designation);
  if (args.family !== undefined) push("machine_family_code", args.family);
  if (args.machineId !== undefined) push("machine_id", args.machineId);
  if (args.programme !== undefined) push("numero_programme", args.programme);
  if (args.tempsUnitaire !== undefined) push("tf_unit", args.tempsUnitaire);
  if (args.preparation !== undefined) push("tp", args.preparation);
  if (args.quantiteBase !== undefined) push("qte", args.quantiteBase);
  if (args.coefficient !== undefined) push("coef", args.coefficient);

  if (!sets.length) return;

  // Les temps dérivés sont recalculés en base pour rester cohérents avec la
  // formule métier, même si l'appelant ne les a pas fournis.
  const res = await tx.query(
    `UPDATE public.of_operations
        SET ${sets.join(", ")},
            temps_fabrication_planned = tf_unit * qte * coef,
            temps_total_planned = tp + tf_unit * qte * coef,
            updated_at = now()
      WHERE of_id = $1 AND revision_id = $2::uuid AND phase = $3`,
    values
  );

  if (!res.rowCount) {
    throw new HttpError(404, "OF_PHASE_NOT_FOUND", `Phase ${args.phase} absente de cette révision.`);
  }
}

/* -------------------------------------------------------------------------- */
/* VISA de phase                                                              */
/* -------------------------------------------------------------------------- */

export type OfVisaRow = {
  phase: number;
  statut: string;
  operateur: string | null;
  initials: string | null;
  visa_at: string | null;
  quantite_bonne: number | null;
  quantite_rebut: number | null;
  motif_rebut: string | null;
  controle_initials: string | null;
  comment: string | null;
  revoked_at: string | null;
};

/** VISA vivants (non révoqués) de la révision, indexés par phase. */
export async function listVisas(
  ofId: number,
  revisionId: string,
  tx: DbQueryer = pool
): Promise<OfVisaRow[]> {
  const res = await tx.query(
    `SELECT op.phase::int                 AS phase,
            v.statut,
            u.username                    AS operateur,
            v.initials,
            v.visa_at,
            v.quantite_bonne::float8      AS quantite_bonne,
            v.quantite_rebut::float8      AS quantite_rebut,
            v.motif_rebut,
            v.controle_initials,
            v.comment,
            v.revoked_at
       FROM public.of_operation_visas v
       JOIN public.of_operations op ON op.id = v.of_operation_id
       LEFT JOIN public.users u ON u.id = v.user_id
      WHERE op.of_id = $1 AND op.revision_id = $2::uuid AND v.revoked_at IS NULL
      ORDER BY op.phase`,
    [ofId, revisionId]
  );
  return res.rows as OfVisaRow[];
}

export async function insertVisa(
  tx: DbQueryer,
  input: {
    ofId: number;
    revisionId: string;
    phase: number;
    userId: number | null;
    initials: string;
    statut: string;
    quantiteBonne: number | null;
    quantiteRebut: number | null;
    motifRebut: string | null;
    controleUserId: number | null;
    controleInitials: string | null;
    comment: string | null;
  }
): Promise<string> {
  // L'opération est résolue par (of_id, revision_id, phase) : un VISA ne peut pas
  // atterrir sur la phase d'un autre OF ni d'une autre révision.
  const op = await tx.query(
    `SELECT id::text AS id FROM public.of_operations
      WHERE of_id = $1 AND revision_id = $2::uuid AND phase = $3`,
    [input.ofId, input.revisionId, input.phase]
  );
  if (!op.rows[0]) {
    throw new HttpError(404, "OF_PHASE_NOT_FOUND", `Phase ${input.phase} absente de cette révision.`);
  }

  const res = await tx.query(
    `INSERT INTO public.of_operation_visas
       (of_operation_id, user_id, initials, visa_at, comment, statut,
        quantite_bonne, quantite_rebut, motif_rebut,
        controle_user_id, controle_initials, controle_at)
     VALUES ($1::uuid, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $10 IS NULL THEN NULL ELSE now() END)
     RETURNING id::text AS id`,
    [
      String(op.rows[0].id),
      input.userId,
      input.initials,
      input.comment,
      input.statut,
      input.quantiteBonne,
      input.quantiteRebut,
      input.motifRebut,
      input.controleUserId,
      input.controleInitials,
    ]
  );
  return String(res.rows[0].id);
}

/* -------------------------------------------------------------------------- */
/* Propositions de replanification                                            */
/* -------------------------------------------------------------------------- */

export type OfProposalRow = {
  id: string;
  of_id: number;
  revision_id: string;
  phase: number;
  reference_time: number | null;
  new_time: number;
  variation_pct: number | null;
  outcome: string;
  review_required: boolean;
  cause: string;
  cause_comment: string | null;
  statut: string;
  impact_charge: unknown;
  machines: unknown;
  affaires: unknown;
  simulation: unknown;
  author_user_id: number | null;
  created_at: string;
  resolved_at: string | null;
  resolution_comment: string | null;
};

export async function listProposals(
  ofId: number,
  tx: DbQueryer = pool
): Promise<OfProposalRow[]> {
  const res = await tx.query(
    `SELECT id::text AS id, of_id::int AS of_id, revision_id::text AS revision_id, phase::int AS phase,
            reference_time::float8 AS reference_time, new_time::float8 AS new_time,
            variation_pct::float8 AS variation_pct, outcome, review_required, cause, cause_comment,
            statut, impact_charge, machines, affaires, simulation,
            author_user_id::int AS author_user_id, created_at, resolved_at, resolution_comment
       FROM public.of_time_variance_proposals
      WHERE of_id = $1
      ORDER BY created_at DESC`,
    [ofId]
  );
  return res.rows as OfProposalRow[];
}

export async function findProposalByIdempotencyKey(
  tx: DbQueryer,
  key: string
): Promise<OfProposalRow | null> {
  const res = await tx.query(
    `SELECT id::text AS id, of_id::int AS of_id, revision_id::text AS revision_id, phase::int AS phase,
            reference_time::float8 AS reference_time, new_time::float8 AS new_time,
            variation_pct::float8 AS variation_pct, outcome, review_required, cause, cause_comment,
            statut, impact_charge, machines, affaires, simulation,
            author_user_id::int AS author_user_id, created_at, resolved_at, resolution_comment
       FROM public.of_time_variance_proposals
      WHERE idempotency_key = $1`,
    [key]
  );
  return (res.rows[0] as OfProposalRow | undefined) ?? null;
}

export async function insertProposal(
  tx: DbQueryer,
  input: {
    ofId: number;
    revisionId: string;
    ofOperationId: string | null;
    phase: number;
    referenceTime: number | null;
    newTime: number;
    variationPct: number | null;
    outcome: string;
    reviewRequired: boolean;
    cause: string;
    causeComment: string | null;
    impactCharge: unknown;
    machines: unknown;
    affaires: unknown;
    simulation: unknown;
    authorUserId: number | null;
    idempotencyKey: string | null;
  }
): Promise<string> {
  const res = await tx.query(
    `INSERT INTO public.of_time_variance_proposals
       (of_id, revision_id, of_operation_id, phase, reference_time, new_time, variation_pct,
        outcome, review_required, cause, cause_comment, impact_charge, machines, affaires,
        simulation, author_user_id, idempotency_key)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17)
     RETURNING id::text AS id`,
    [
      input.ofId,
      input.revisionId,
      input.ofOperationId,
      input.phase,
      input.referenceTime,
      input.newTime,
      input.variationPct,
      input.outcome,
      input.reviewRequired,
      input.cause,
      input.causeComment,
      JSON.stringify(input.impactCharge),
      JSON.stringify(input.machines),
      JSON.stringify(input.affaires),
      JSON.stringify(input.simulation),
      input.authorUserId,
      input.idempotencyKey,
    ]
  );
  return String(res.rows[0].id);
}

export async function resolveProposal(
  tx: DbQueryer,
  args: { ofId: number; proposalId: string; statut: string; userId: number | null; comment: string | null }
): Promise<void> {
  const res = await tx.query(
    `UPDATE public.of_time_variance_proposals
        SET statut = $3, resolved_at = now(), resolved_by = $4, resolution_comment = $5
      WHERE id = $2::uuid AND of_id = $1 AND statut = 'OUVERTE'`,
    [args.ofId, args.proposalId, args.statut, args.userId, args.comment]
  );
  if (!res.rowCount) {
    throw new HttpError(
      409,
      "OF_PROPOSAL_NOT_OPEN",
      "Proposition introuvable sur cet OF, ou déjà tranchée."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Versions de planning                                                       */
/* -------------------------------------------------------------------------- */

export type OfPlanningVersionRow = {
  id: string;
  of_id: number;
  revision_id: string | null;
  version_rank: number;
  statut: OfPlanningStatut;
  payload: OfPlanningPayload;
  payload_sha256: string;
  base_version_id: string | null;
  comparison: unknown;
  client_impact: string;
  source_proposal_id: string | null;
  author_user_id: number | null;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  activated_at: string | null;
};

const PLANNING_SELECT = `
  SELECT id::text                 AS id,
         of_id::int               AS of_id,
         revision_id::text        AS revision_id,
         version_rank::int        AS version_rank,
         statut,
         payload,
         payload_sha256,
         base_version_id::text    AS base_version_id,
         comparison,
         client_impact,
         source_proposal_id::text AS source_proposal_id,
         author_user_id::int      AS author_user_id,
         created_at, submitted_at, decided_at, decision_comment, activated_at
    FROM public.of_planning_versions`;

export async function listPlanningVersions(
  ofId: number,
  tx: DbQueryer = pool
): Promise<OfPlanningVersionRow[]> {
  const res = await tx.query(`${PLANNING_SELECT} WHERE of_id = $1 ORDER BY version_rank DESC`, [ofId]);
  return res.rows as OfPlanningVersionRow[];
}

export async function getPlanningVersion(
  ofId: number,
  versionId: string,
  tx: DbQueryer = pool
): Promise<OfPlanningVersionRow | null> {
  const res = await tx.query(`${PLANNING_SELECT} WHERE id = $1::uuid AND of_id = $2`, [versionId, ofId]);
  return (res.rows[0] as OfPlanningVersionRow | undefined) ?? null;
}

export async function getPlanningByStatut(
  ofId: number,
  statuts: readonly OfPlanningStatut[],
  tx: DbQueryer = pool
): Promise<OfPlanningVersionRow | null> {
  const res = await tx.query(
    `${PLANNING_SELECT} WHERE of_id = $1 AND statut = ANY($2::text[]) ORDER BY version_rank DESC LIMIT 1`,
    [ofId, statuts as unknown as string[]]
  );
  return (res.rows[0] as OfPlanningVersionRow | undefined) ?? null;
}

export async function nextPlanningRank(tx: DbQueryer, ofId: number): Promise<number> {
  const res = await tx.query(
    `SELECT COALESCE(MAX(version_rank), -1) + 1 AS next FROM public.of_planning_versions WHERE of_id = $1`,
    [ofId]
  );
  return Number(res.rows[0].next);
}

export async function findPlanningByIdempotencyKey(
  tx: DbQueryer,
  key: string
): Promise<OfPlanningVersionRow | null> {
  const res = await tx.query(`${PLANNING_SELECT} WHERE idempotency_key = $1`, [key]);
  return (res.rows[0] as OfPlanningVersionRow | undefined) ?? null;
}

export async function insertPlanningVersion(
  tx: DbQueryer,
  input: {
    ofId: number;
    revisionId: string | null;
    rank: number;
    statut: OfPlanningStatut;
    payload: OfPlanningPayload;
    payloadSha256: string;
    baseVersionId: string | null;
    comparison: unknown;
    clientImpact: string;
    sourceProposalId: string | null;
    authorUserId: number | null;
    idempotencyKey: string | null;
  }
): Promise<OfPlanningVersionRow> {
  const res = await tx.query(
    `INSERT INTO public.of_planning_versions
       (of_id, revision_id, version_rank, statut, payload, payload_sha256, base_version_id,
        comparison, client_impact, source_proposal_id, author_user_id, idempotency_key,
        activated_at)
     VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid, $8::jsonb, $9, $10::uuid, $11, $12,
             CASE WHEN $4 = 'ACTIF' THEN now() ELSE NULL END)
     RETURNING id::text AS id`,
    [
      input.ofId,
      input.revisionId,
      input.rank,
      input.statut,
      JSON.stringify(input.payload),
      input.payloadSha256,
      input.baseVersionId,
      input.comparison === undefined ? null : JSON.stringify(input.comparison),
      input.clientImpact,
      input.sourceProposalId,
      input.authorUserId,
      input.idempotencyKey,
    ]
  );

  const created = await getPlanningVersion(input.ofId, String(res.rows[0].id), tx);
  if (!created) throw new HttpError(500, "OF_PLANNING_CREATE", "Version de planning introuvable après création.");
  return created;
}

/**
 * Change le statut d'une version de planning, avec verrou optimiste.
 *
 * `expectedStatut` est la garde : la ligne n'est mise à jour que si elle est
 * toujours dans l'état que l'appelant croyait. Deux validations simultanées ne
 * peuvent donc pas aboutir toutes les deux — la seconde reçoit un 409 explicite
 * au lieu d'écraser la décision de la première.
 */
export async function transitionPlanningVersion(
  tx: DbQueryer,
  args: {
    ofId: number;
    versionId: string;
    expectedStatut: OfPlanningStatut;
    nextStatut: OfPlanningStatut;
    userId: number | null;
    comment?: string | null;
  }
): Promise<void> {
  const stamps: string[] = [];
  if (args.nextStatut === "SOUMIS") stamps.push("submitted_at = now()", `submitted_by = $5`);
  if (args.nextStatut === "VALIDE" || args.nextStatut === "REFUSE") {
    stamps.push("decided_at = now()", `decided_by = $5`, `decision_comment = $6`);
  }
  if (args.nextStatut === "ACTIF") stamps.push("activated_at = now()");
  if (args.nextStatut === "SUPERSEDE") stamps.push("superseded_at = now()");

  const res = await tx.query(
    `UPDATE public.of_planning_versions
        SET statut = $4${stamps.length ? ", " + stamps.join(", ") : ""}
      WHERE id = $2::uuid AND of_id = $1 AND statut = $3`,
    [args.ofId, args.versionId, args.expectedStatut, args.nextStatut, args.userId, args.comment ?? null]
  );

  if (!res.rowCount) {
    throw new HttpError(
      409,
      "OF_PLANNING_CONFLICT",
      `La version de planning n'est plus dans l'état « ${args.expectedStatut} » : elle a été modifiée entre-temps.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Dossiers d'AR à recaler                                                    */
/* -------------------------------------------------------------------------- */

export type ArRecalageRow = {
  id: string;
  client_id: string | null;
  client_nom: string | null;
  commande_id: number | null;
  commande_ligne_id: number | null;
  affaire_id: number | null;
  affaire_reference: string | null;
  of_id: number;
  of_numero: string | null;
  planning_version_id: string | null;
  previous_date: string | null;
  new_date: string | null;
  previous_cadence: unknown;
  new_cadence: unknown;
  quantite: number | null;
  motif: string;
  commentaire: string | null;
  statut: string;
  owner_user_id: number | null;
  owner_label: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

const AR_SELECT = `
  SELECT d.id::text                  AS id,
         d.client_id::text            AS client_id,
         c.nom_client                 AS client_nom,
         d.commande_id::int           AS commande_id,
         NULL::int                    AS commande_ligne_id,
         d.affaire_id::int            AS affaire_id,
         a.reference                  AS affaire_reference,
         d.of_id::int                 AS of_id,
         o.numero                     AS of_numero,
         d.planning_version_id::text  AS planning_version_id,
         d.previous_date::text        AS previous_date,
         d.new_date::text             AS new_date,
         d.previous_cadence, d.new_cadence,
         d.quantite::float8           AS quantite,
         d.motif, d.commentaire, d.statut,
         d.owner_user_id::int         AS owner_user_id,
         u.username                   AS owner_label,
         d.created_at, d.updated_at, d.closed_at
    FROM public.ar_recalage_dossiers d
    LEFT JOIN public.clients c ON c.client_id = d.client_id
    LEFT JOIN public.affaire a ON a.id = d.affaire_id
    LEFT JOIN public.ordres_fabrication o ON o.id = d.of_id
    LEFT JOIN public.users u ON u.id = d.owner_user_id`;

export async function listArDossiers(
  filters: { ofId?: number; statut?: string },
  tx: DbQueryer = pool
): Promise<ArRecalageRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.ofId !== undefined) {
    values.push(filters.ofId);
    where.push(`d.of_id = $${values.length}`);
  }
  if (filters.statut) {
    values.push(filters.statut);
    where.push(`d.statut = $${values.length}`);
  }
  const res = await tx.query(
    `${AR_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC`,
    values
  );
  return res.rows as ArRecalageRow[];
}

export async function getArDossier(
  dossierId: string,
  tx: DbQueryer = pool
): Promise<ArRecalageRow | null> {
  const res = await tx.query(`${AR_SELECT} WHERE d.id = $1::uuid`, [dossierId]);
  return (res.rows[0] as ArRecalageRow | undefined) ?? null;
}

export async function findArByIdempotencyKey(tx: DbQueryer, key: string): Promise<ArRecalageRow | null> {
  const res = await tx.query(`${AR_SELECT} WHERE d.idempotency_key = $1`, [key]);
  return (res.rows[0] as ArRecalageRow | undefined) ?? null;
}

export async function insertArDossier(
  tx: DbQueryer,
  input: {
    clientId: string | null;
    commandeId: number | null;
    affaireId: number | null;
    ofId: number;
    planningVersionId: string | null;
    previousDate: string | null;
    newDate: string | null;
    previousCadence: unknown;
    newCadence: unknown;
    quantite: number | null;
    motif: string;
    commentaire: string | null;
    ownerUserId: number | null;
    createdBy: number | null;
    idempotencyKey: string | null;
  }
): Promise<string> {
  const res = await tx.query(
    `INSERT INTO public.ar_recalage_dossiers
       (client_id, commande_id, affaire_id, of_id, planning_version_id,
        previous_date, new_date, previous_cadence, new_cadence, quantite,
        motif, commentaire, owner_user_id, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::date, $7::date, $8::jsonb, $9::jsonb, $10,
             $11, $12, $13, $14, $15)
     RETURNING id::text AS id`,
    [
      input.clientId,
      input.commandeId,
      input.affaireId,
      input.ofId,
      input.planningVersionId,
      input.previousDate,
      input.newDate,
      input.previousCadence === undefined ? null : JSON.stringify(input.previousCadence),
      input.newCadence === undefined ? null : JSON.stringify(input.newCadence),
      input.quantite,
      input.motif,
      input.commentaire,
      input.ownerUserId,
      input.createdBy,
      input.idempotencyKey,
    ]
  );
  return String(res.rows[0].id);
}

export async function updateArDossier(
  tx: DbQueryer,
  args: {
    dossierId: string;
    expectedStatut: string;
    statut: string;
    ownerUserId?: number | null;
    commentaire?: string | null;
    userId: number | null;
  }
): Promise<void> {
  const res = await tx.query(
    `UPDATE public.ar_recalage_dossiers
        SET statut = $3,
            owner_user_id = COALESCE($4, owner_user_id),
            commentaire = COALESCE($5, commentaire),
            updated_at = now(),
            closed_at = CASE WHEN $3 IN ('RECALE', 'ABANDONNE') THEN now() ELSE closed_at END,
            closed_by = CASE WHEN $3 IN ('RECALE', 'ABANDONNE') THEN $6 ELSE closed_by END
      WHERE id = $1::uuid AND statut = $2`,
    [
      args.dossierId,
      args.expectedStatut,
      args.statut,
      args.ownerUserId ?? null,
      args.commentaire ?? null,
      args.userId,
    ]
  );
  if (!res.rowCount) {
    throw new HttpError(
      409,
      "AR_RECALAGE_CONFLICT",
      `Le dossier n'est plus dans l'état « ${args.expectedStatut} » : il a été modifié entre-temps.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Documents d'OF                                                             */
/* -------------------------------------------------------------------------- */

export type OfDocumentRow = {
  id: string;
  of_id: number;
  revision_id: string;
  payload: unknown;
  payload_sha256: string;
  pdf_sha256: string | null;
  pdf_byte_size: number | null;
  generated_at: string;
  generated_by: number | null;
  generated_by_label: string | null;
  statut: string;
  ged_document_id: string | null;
  ged_version_id: string | null;
  reprint_count: number;
  last_reprinted_at: string | null;
};

export type OfDocumentCommitExpectation = Readonly<{
  documentId: string;
  ofId: number;
  revisionId: string;
  payloadSha256: string;
  pdfSha256: string;
  pdfByteSize: number;
  gedDocumentId: string | null;
  gedVersionId: string | null;
  gedBlobStorageKey: string | null;
  gedVersionStatus: "BROUILLON" | null;
  gedDocumentWasPreexisting: boolean;
}>;

export type OfDocumentCommitReconciliation = "committed" | "not-committed" | "uncertain";

/**
 * Fresh exact reconciliation after a lost COMMIT acknowledgement. The query
 * always returns one row so absence of both the business row and the exact GED
 * version can be distinguished from any partial/mismatching state.
 */
export async function reconcileOfDocumentMetadataCommit(
  expected: OfDocumentCommitExpectation
): Promise<OfDocumentCommitReconciliation> {
  const res = await pool.query<{
    document_id: string | null;
    of_id: number | null;
    revision_id: string | null;
    payload_sha256: string | null;
    pdf_sha256: string | null;
    pdf_byte_size: number | null;
    ged_document_id: string | null;
    ged_version_id: string | null;
    ged_document_row_id: string | null;
    ged_document_current_version_id: string | null;
    ged_document_archived_at: string | null;
    ged_version_document_id: string | null;
    ged_version_status: string | null;
    ged_blob_sha256: string | null;
    ged_blob_storage_key: string | null;
    ged_blob_size_bytes: string | null;
  }>(
    `SELECT
       d.id::text AS document_id,
       d.of_id::int AS of_id,
       d.revision_id::text AS revision_id,
       d.payload_sha256,
       d.pdf_sha256,
       d.pdf_byte_size::int AS pdf_byte_size,
       d.ged_document_id::text AS ged_document_id,
       d.ged_version_id::text AS ged_version_id,
       gd.id::text AS ged_document_row_id,
       gd.current_version_id::text AS ged_document_current_version_id,
       gd.archived_at::text AS ged_document_archived_at,
       gv.document_id::text AS ged_version_document_id,
       gv.status::text AS ged_version_status,
       gb.sha256 AS ged_blob_sha256,
       gb.storage_key AS ged_blob_storage_key,
       gb.size_bytes::bigint::text AS ged_blob_size_bytes
     FROM (SELECT 1) anchor
     LEFT JOIN public.of_documents d ON d.id = $1::uuid
     LEFT JOIN public.ged_document_versions gv ON gv.id = $2::uuid
     LEFT JOIN public.ged_blobs gb ON gb.id = gv.blob_id
     LEFT JOIN public.ged_documents gd ON gd.id = $3::uuid`,
    [expected.documentId, expected.gedVersionId, expected.gedDocumentId]
  );
  const row = res.rows[0];
  if (!row) return "uncertain";

  if (!row.document_id) {
    if (row.ged_version_document_id) return "uncertain";
    if (!expected.gedDocumentId || expected.gedDocumentWasPreexisting) return "not-committed";
    return row.ged_document_row_id ? "uncertain" : "not-committed";
  }

  const businessMatches = row.document_id === expected.documentId
    && Number(row.of_id) === expected.ofId
    && row.revision_id === expected.revisionId
    && row.payload_sha256 === expected.payloadSha256
    && row.pdf_sha256 === expected.pdfSha256
    && Number(row.pdf_byte_size) === expected.pdfByteSize
    && row.ged_document_id === expected.gedDocumentId
    && row.ged_version_id === expected.gedVersionId;
  if (!businessMatches) return "uncertain";

  if (!expected.gedVersionId) {
    return row.ged_version_document_id === null && row.ged_document_row_id === null
      ? "committed"
      : "uncertain";
  }

  const gedMatches = row.ged_document_row_id === expected.gedDocumentId
    && row.ged_document_current_version_id === expected.gedVersionId
    && row.ged_document_archived_at === null
    && row.ged_version_document_id === expected.gedDocumentId
    && (expected.gedVersionStatus === null || row.ged_version_status === expected.gedVersionStatus)
    && row.ged_blob_sha256 === expected.pdfSha256
    && row.ged_blob_storage_key === expected.gedBlobStorageKey
    && Number(row.ged_blob_size_bytes) === expected.pdfByteSize;
  return gedMatches ? "committed" : "uncertain";
}

const DOCUMENT_SELECT = `
  SELECT id::text              AS id,
         of_id::int            AS of_id,
         revision_id::text     AS revision_id,
         payload, payload_sha256, pdf_sha256,
         pdf_byte_size::int    AS pdf_byte_size,
         generated_at,
         generated_by::int     AS generated_by,
         generated_by_label, statut,
         ged_document_id::text AS ged_document_id,
         ged_version_id::text  AS ged_version_id,
         reprint_count::int    AS reprint_count,
         last_reprinted_at
    FROM public.of_documents`;

export async function listDocuments(ofId: number, tx: DbQueryer = pool): Promise<OfDocumentRow[]> {
  const res = await tx.query(`${DOCUMENT_SELECT} WHERE of_id = $1 ORDER BY generated_at DESC`, [ofId]);
  return res.rows as OfDocumentRow[];
}

export async function getDocument(
  ofId: number,
  documentId: string,
  tx: DbQueryer = pool
): Promise<OfDocumentRow | null> {
  const res = await tx.query(`${DOCUMENT_SELECT} WHERE id = $1::uuid AND of_id = $2`, [documentId, ofId]);
  return (res.rows[0] as OfDocumentRow | undefined) ?? null;
}

export async function getOfficialDocument(
  ofId: number,
  revisionId: string,
  tx: DbQueryer = pool
): Promise<OfDocumentRow | null> {
  const res = await tx.query(
    `${DOCUMENT_SELECT} WHERE of_id = $1 AND revision_id = $2::uuid AND statut = 'OFFICIEL'`,
    [ofId, revisionId]
  );
  return (res.rows[0] as OfDocumentRow | undefined) ?? null;
}

/** Document GED déjà ouvert pour cet OF, pour y ajouter une version. */
export async function findExistingGedDocumentId(
  tx: DbQueryer,
  ofId: number
): Promise<string | null> {
  const res = await tx.query(
    `SELECT ged_document_id::text AS id
       FROM public.of_documents
      WHERE of_id = $1 AND ged_document_id IS NOT NULL
      ORDER BY generated_at DESC
      LIMIT 1`,
    [ofId]
  );
  return res.rows[0] ? String(res.rows[0].id) : null;
}

export async function findDocumentByIdempotencyKey(
  tx: DbQueryer,
  key: string
): Promise<OfDocumentRow | null> {
  const res = await tx.query(`${DOCUMENT_SELECT} WHERE idempotency_key = $1`, [key]);
  return (res.rows[0] as OfDocumentRow | undefined) ?? null;
}

export async function insertDocument(
  tx: DbQueryer,
  input: {
    ofId: number;
    revisionId: string;
    payload: unknown;
    payloadSha256: string;
    pdfSha256: string | null;
    pdfByteSize: number | null;
    generatedAt: string;
    generatedBy: number | null;
    generatedByLabel: string | null;
    statut: string;
    gedDocumentId: string | null;
    gedVersionId: string | null;
    idempotencyKey: string | null;
  }
): Promise<OfDocumentRow> {
  // Les documents officiels antérieurs de CET OF deviennent OBSOLETE : un seul
  // exemplaire courant circule en atelier. Ils ne sont jamais supprimés — le
  // trigger d'immuabilité l'interdit, et l'historique documentaire doit rester.
  if (input.statut === "OFFICIEL") {
    await tx.query(
      `UPDATE public.of_documents SET statut = 'OBSOLETE'
        WHERE of_id = $1 AND statut = 'OFFICIEL'`,
      [input.ofId]
    );
  }

  const res = await tx.query(
    `INSERT INTO public.of_documents
       (of_id, revision_id, payload, payload_sha256, pdf_sha256, pdf_byte_size,
        generated_at, generated_by, generated_by_label, statut,
        ged_document_id, ged_version_id, idempotency_key)
     VALUES ($1, $2::uuid, $3::jsonb, $4, $5, $6, $7::timestamptz, $8, $9, $10,
             $11::uuid, $12::uuid, $13)
     RETURNING id::text AS id`,
    [
      input.ofId,
      input.revisionId,
      JSON.stringify(input.payload),
      input.payloadSha256,
      input.pdfSha256,
      input.pdfByteSize,
      input.generatedAt,
      input.generatedBy,
      input.generatedByLabel,
      input.statut,
      input.gedDocumentId,
      input.gedVersionId,
      input.idempotencyKey,
    ]
  );

  const created = await getDocument(input.ofId, String(res.rows[0].id), tx);
  if (!created) throw new HttpError(500, "OF_DOCUMENT_CREATE", "Document introuvable après création.");
  return created;
}

/**
 * Incrémente le compteur de réimpression.
 *
 * Une réimpression n'est PAS une émission : elle ne crée ni révision, ni
 * document, ni version GED. Elle laisse seulement une trace de consultation.
 */
export async function bumpReprintCount(
  tx: DbQueryer,
  args: { ofId: number; documentId: string }
): Promise<void> {
  await tx.query(
    `UPDATE public.of_documents
        SET reprint_count = reprint_count + 1, last_reprinted_at = now()
      WHERE id = $2::uuid AND of_id = $1`,
    [args.ofId, args.documentId]
  );
}

/* -------------------------------------------------------------------------- */
/* Read-model commercial : affaires, cadences, couverture                     */
/* -------------------------------------------------------------------------- */

export type OfCommercialContext = {
  affaires: Array<{ affaireId: number; numero: string | null; delaiClient: string | null; quantite: number | null }>;
  cadenceLivraison: Array<{ date: string; quantite: number; affaireNumero: string | null }>;
  quantites: {
    quantiteDemandee: number;
    quantiteLivree: number;
    stockReserve: number;
    couvertAutresOf: number;
    quantiteAffecteeCetOf: number;
  };
  derniereFabrication: { numero: string | null; date: string | null } | null;
};

/**
 * Contexte commercial d'un OF, en postes DISJOINTS.
 *
 * Le non-double-comptage n'est pas obtenu par un correctif après coup : il vient
 * de la table `commande_ligne_affaire_allocation`, qui décompose déjà la
 * quantité commandée en « depuis stock », « réservée » et « à produire ». On lit
 * cette décomposition au lieu d'additionner des sources indépendantes qui se
 * recouperaient.
 *
 * `couvertAutresOf` exclut explicitement l'OF courant et ne retient que les OF
 * ACTIFS : la sortie d'un OF terminé est entrée en stock, la compter en plus du
 * stock réservé couvrirait deux fois la même pièce.
 */
export async function readCommercialContext(
  header: OfHeaderRow,
  tx: DbQueryer = pool
): Promise<OfCommercialContext> {
  const affaires: OfCommercialContext["affaires"] = [];
  const cadenceLivraison: OfCommercialContext["cadenceLivraison"] = [];

  if (header.commande_ligne_id !== null) {
    const alloc = await tx.query(
      `SELECT al.livraison_affaire_id::int      AS affaire_id,
              a.reference                        AS numero,
              cl.delai_client::text              AS delai_client,
              al.qty_ordered::float8             AS qty_ordered,
              al.qty_from_stock::float8          AS qty_from_stock,
              al.qty_reserved::float8            AS qty_reserved,
              al.qty_to_produce::float8          AS qty_to_produce
         FROM public.commande_ligne_affaire_allocation al
         LEFT JOIN public.affaire a        ON a.id = al.livraison_affaire_id
         LEFT JOIN public.commande_ligne cl ON cl.id = al.commande_ligne_id
        WHERE al.commande_ligne_id = $1
        ORDER BY al.livraison_affaire_id`,
      [header.commande_ligne_id]
    );

    for (const row of alloc.rows) {
      if (row.affaire_id !== null) {
        affaires.push({
          affaireId: Number(row.affaire_id),
          numero: row.numero === null ? null : String(row.numero),
          delaiClient: row.delai_client === null ? null : String(row.delai_client),
          quantite: row.qty_ordered === null ? null : Number(row.qty_ordered),
        });
      }
    }
  }

  // L'affaire portée par l'OF lui-même, si l'allocation ne l'a pas déjà donnée.
  if (header.affaire_id !== null && !affaires.some((a) => a.affaireId === header.affaire_id)) {
    const own = await tx.query(
      `SELECT id::int AS id, reference FROM public.affaire WHERE id = $1`, // `affaire.reference` vérifié au schéma
      [header.affaire_id]
    );
    if (own.rows[0]) {
      affaires.push({
        affaireId: Number(own.rows[0].id),
        numero: own.rows[0].reference === null ? null : String(own.rows[0].reference),
        delaiClient: header.date_fin_prevue,
        quantite: header.quantite_lancee,
      });
    }
  }

  if (header.commande_id !== null) {
    const echeances = await tx.query(
      `SELECT date_echeance::text AS date, COALESCE(pourcentage, 0)::float8 AS pct, libelle
         FROM public.commande_echeance
        WHERE commande_id = $1 AND date_echeance IS NOT NULL
        ORDER BY date_echeance`,
      [header.commande_id]
    );
    for (const row of echeances.rows) {
      cadenceLivraison.push({
        date: String(row.date),
        // Une échéance de commande porte un pourcentage : la quantité en découle.
        quantite: Number(((Number(row.pct) / 100) * header.quantite_lancee).toFixed(3)),
        affaireNumero: row.libelle === null ? null : String(row.libelle),
      });
    }
  }

  const quantites = await readCoverage(header, tx);
  const derniere = await readLastFabrication(header, tx);

  return { affaires, cadenceLivraison, quantites, derniereFabrication: derniere };
}

async function readCoverage(
  header: OfHeaderRow,
  tx: DbQueryer
): Promise<OfCommercialContext["quantites"]> {
  let quantiteDemandee = header.quantite_lancee;
  let stockReserve = 0;
  let quantiteLivree = 0;

  if (header.commande_ligne_id !== null) {
    const res = await tx.query(
      `SELECT COALESCE(SUM(qty_ordered), 0)::float8    AS demandee,
              COALESCE(SUM(qty_from_stock), 0)::float8 AS from_stock,
              COALESCE(SUM(qty_reserved), 0)::float8   AS reserved
         FROM public.commande_ligne_affaire_allocation
        WHERE commande_ligne_id = $1`,
      [header.commande_ligne_id]
    );
    if (res.rows[0]) {
      quantiteDemandee = Number(res.rows[0].demandee) || header.quantite_lancee;
      // `qty_from_stock` est servi depuis le stock : c'est une couverture, mais
      // pas une production. `qty_reserved` est la réservation physique.
      stockReserve = Number(res.rows[0].from_stock) + Number(res.rows[0].reserved);
    }
  }

  // Quantité déjà reçue en bon sur cet OF : c'est la part produite et acceptée.
  const recu = await tx.query(
    `SELECT COALESCE(quantite_bonne, 0)::float8 AS bonne FROM public.ordres_fabrication WHERE id = $1`,
    [header.of_id]
  );
  quantiteLivree = recu.rows[0] ? Number(recu.rows[0].bonne) : 0;

  // Autres OF ACTIFS sur la même ligne de commande. L'OF courant est exclu, et
  // les OF terminés ou annulés le sont aussi : leur sortie est déjà en stock.
  let couvertAutresOf = 0;
  if (header.commande_ligne_id !== null) {
    const autres = await tx.query(
      `SELECT COALESCE(SUM(quantite_lancee), 0)::float8 AS q
         FROM public.ordres_fabrication
        WHERE commande_ligne_id = $1
          AND id <> $2
          AND statut::text NOT IN ('TERMINE', 'CLOTURE', 'ANNULE')`,
      [header.commande_ligne_id, header.of_id]
    );
    couvertAutresOf = autres.rows[0] ? Number(autres.rows[0].q) : 0;
  }

  return {
    quantiteDemandee,
    quantiteLivree,
    stockReserve,
    couvertAutresOf,
    quantiteAffecteeCetOf: header.quantite_lancee,
  };
}

async function readLastFabrication(
  header: OfHeaderRow,
  tx: DbQueryer
): Promise<{ numero: string | null; date: string | null } | null> {
  if (header.piece_technique_id === null) return null;
  const res = await tx.query(
    `SELECT numero, COALESCE(date_fin_reelle, date_fin_prevue)::text AS date
       FROM public.ordres_fabrication
      WHERE piece_technique_id = $1::uuid
        AND id <> $2
        AND date_fin_reelle IS NOT NULL
      ORDER BY date_fin_reelle DESC
      LIMIT 1`,
    [header.piece_technique_id, header.of_id]
  );
  if (!res.rows[0]) return null;
  return {
    numero: res.rows[0].numero === null ? null : String(res.rows[0].numero),
    date: res.rows[0].date === null ? null : String(res.rows[0].date),
  };
}

/* -------------------------------------------------------------------------- */
/* Routage de notification                                                    */
/* -------------------------------------------------------------------------- */

export async function readNotificationRouting(
  topic: string,
  tx: DbQueryer = pool
): Promise<NotificationRoutingRule[]> {
  const res = await tx.query(
    `SELECT topic, role_key, user_id::int AS user_id, is_active
       FROM public.notification_routing
      WHERE topic = $1 AND is_active = true`,
    [topic]
  );
  return res.rows.map((row) => ({
    topic: String(row.topic),
    roleKey: row.role_key === null ? null : String(row.role_key),
    userId: row.user_id === null ? null : Number(row.user_id),
    isActive: Boolean(row.is_active),
  }));
}

/** Destinataires possibles : utilisateurs actifs avec leurs rôles assignés. */
export async function readNotificationCandidates(
  tx: DbQueryer = pool
): Promise<Array<{ userId: number; username: string; primaryRole: string | null; roles: string[] }>> {
  const res = await tx.query(
    `SELECT u.id::int AS user_id, u.username, u.role AS primary_role,
            COALESCE(ARRAY_AGG(ura.role_key) FILTER (WHERE ura.role_key IS NOT NULL), '{}') AS roles
       FROM public.users u
       LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      GROUP BY u.id, u.username, u.role`
  );
  return res.rows.map((row) => ({
    userId: Number(row.user_id),
    username: String(row.username),
    primaryRole: row.primary_role === null ? null : String(row.primary_role),
    roles: Array.isArray(row.roles) ? row.roles.map((r: unknown) => String(r)) : [],
  }));
}
