import type { PreparationDecisions } from "../domain/preparation-rules";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import type { AuditContext } from "./production.repository";
import { synchronizeDraftChildrenTx } from "./preparation-children.repository";
import {
  assertPreparationMutable,
  loadPreparationOrder,
  persistPreparationEvaluation,
  preparationAudit,
  invalidateCompatibleDrafts,
} from "./production-preparation.repository";
export async function repoSynchronizePreparationChildren(
  id: number,
  expected: string,
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, expected);
    if (of.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "TECHNICAL_SNAPSHOT_FROZEN",
        "La structure de cet OF est figée.",
      );
    const children = await synchronizeDraftChildrenTx(tx, id, audit.user_id);
    await tx.query(
      "UPDATE public.ordres_fabrication SET updated_at=now(),updated_by=$2 WHERE id=$1",
      [id, audit.user_id],
    );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.children.synchronize",
      { affected_of_ids: children },
    );
    return persistPreparationEvaluation(tx, id);
  });
}

export async function repoSaveProgrammingTask(
  id: number,
  input: {
    decisions?: Omit<PreparationDecisions, "programming">;
    expected_profile_version?: number;
    expected_updated_at: string;
    expected_task_updated_at?: string;
    assignee_id: number;
    estimated_hours: number;
    status: "TODO" | "DONE";
    program_reference?: string;
  },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    if (!of.version_id)
      throw new HttpError(422, "VERSION_REQUIRED", "Sélectionnez un indice.");
    if (of.updated_at !== input.expected_updated_at)
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "Le dossier a changé. Actualisez-le.",
      );
    await tx.query(
      "SELECT id FROM public.piece_technique_versions WHERE id=$1::uuid FOR UPDATE",
      [of.version_id],
    );
    const task = (
      await tx.query<{
        id: string;
        updated_at: string;
        status: string;
        assignee_id: number;
        estimated_hours: string;
      }>(
        "SELECT id::text,updated_at::text,status,assignee_id,estimated_hours FROM public.piece_version_programming_tasks WHERE piece_technique_version_id=$1::uuid FOR UPDATE",
        [of.version_id],
      )
    ).rows[0];
    if (task?.updated_at !== input.expected_task_updated_at)
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "La tâche a changé. Actualisez-la.",
      );
    if (
      of.technical_snapshot_sha256 &&
      (!task ||
        task.status === "DONE" ||
        input.status !== "DONE" ||
        input.assignee_id !== task.assignee_id ||
        input.estimated_hours !== Number(task.estimated_hours))
    )
      throw new HttpError(
        409,
        "PROGRAMMING_DEFINITION_FROZEN",
        "La définition est figée. Seule la réalisation de la tâche prévue peut être enregistrée.",
      );
    const user = (
      await tx.query(
        `SELECT id FROM public.users WHERE id=$1 AND status='Active' AND (lower(role) SIMILAR TO '%(admin|directeur|program|method|méthod|production)%')`,
        [input.assignee_id],
      )
    ).rows[0];
    if (!user)
      throw new HttpError(
        422,
        "PROGRAMMER_REQUIRED",
        "Sélectionnez un responsable actif habilité à la programmation.",
      );
    const saved = (
      await tx.query<{ id: string }>(
        `INSERT INTO public.piece_version_programming_tasks(piece_technique_version_id,assignee_id,estimated_hours,status,program_reference,completed_at,completed_by,updated_by)
      VALUES($1::uuid,$2,$3,$4,$5,CASE WHEN $4='DONE' THEN now() END,CASE WHEN $4='DONE' THEN $6::integer END,$6)
      ON CONFLICT(piece_technique_version_id) DO UPDATE SET assignee_id=excluded.assignee_id,estimated_hours=excluded.estimated_hours,status=excluded.status,
      program_reference=excluded.program_reference,completed_at=excluded.completed_at,completed_by=excluded.completed_by,updated_by=excluded.updated_by,updated_at=now() RETURNING id::text`,
        [
          of.version_id,
          input.assignee_id,
          input.estimated_hours,
          input.status,
          input.program_reference ?? null,
          audit.user_id,
        ],
      )
    ).rows[0];
    if (!of.technical_snapshot_sha256) {
      const profile = (
        await tx.query<{ version: number }>(
          "SELECT version FROM public.piece_version_preparation WHERE piece_technique_version_id=$1::uuid FOR UPDATE",
          [of.version_id],
        )
      ).rows[0];
      if (
        input.decisions &&
        (profile?.version ?? 0) !== input.expected_profile_version
      )
        throw new HttpError(
          409,
          "CONCURRENT_MODIFICATION",
          "Les choix de cet indice ont changé. Rechargez le dossier.",
        );
      await tx.query(
        `INSERT INTO public.piece_version_preparation(piece_technique_version_id,decisions,updated_by) VALUES($1::uuid,COALESCE($5::jsonb,'{}'::jsonb)||jsonb_build_object('programming',jsonb_build_object('mode','TASK','task_id',$2::text,'estimated_hours',$3::numeric)),$4)
        ON CONFLICT(piece_technique_version_id) DO UPDATE SET decisions=piece_version_preparation.decisions||excluded.decisions,version=piece_version_preparation.version+1,approved_source_hash=NULL,approved_at=NULL,approved_by=NULL,updated_by=$4,updated_at=now()`,
        [
          of.version_id,
          saved.id,
          input.estimated_hours,
          audit.user_id,
          input.decisions ? JSON.stringify(input.decisions) : null,
        ],
      );
      await invalidateCompatibleDrafts(
        tx,
        of.piece_technique_id,
        of.version_id,
        audit,
      );
    }
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.programming.save",
      { task_id: saved.id, ...input },
    );
    return persistPreparationEvaluation(tx, id);
  });
}

export async function repoImportPreparationPurchases(
  id: number,
  input: { expected_updated_at: string; source_version_id: string | null },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, input.expected_updated_at);
    if (!of.version_id || of.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "PURCHASE_DEFINITION_FROZEN",
        "Sélectionnez une révision en préparation.",
      );
    const version = (
      await tx.query<{ statut: string }>(
        "SELECT statut FROM public.piece_technique_versions WHERE id=$1::uuid FOR UPDATE",
        [of.version_id],
      )
    ).rows[0];
    if (!version || !["BROUILLON", "EN_VALIDATION"].includes(version.statut))
      throw new HttpError(
        409,
        "PURCHASE_VERSION_LOCKED",
        "Créez une révision pour compléter les achats.",
      );
    if (input.source_version_id === of.version_id)
      throw new HttpError(
        422,
        "PURCHASE_SOURCE_INVALID",
        "Sélectionnez une autre révision source.",
      );
    const existing = (
      await tx.query(
        `SELECT id FROM public.pieces_techniques_achats WHERE piece_technique_version_id=$1::uuid LIMIT 1`,
        [of.version_id],
      )
    ).rows[0];
    if (existing)
      throw new HttpError(
        409,
        "PURCHASE_IMPORT_NOT_EMPTY",
        "Des achats existent déjà sur cette révision. Complétez les lignes existantes.",
      );
    const copied = await tx.query(
      `INSERT INTO public.pieces_techniques_achats(piece_technique_id,piece_technique_version_id,phase,nom,designation,article_id,fournisseur_id,fournisseur_nom,quantite,quantite_pieces,pu_achat,unite_prix,type_achat)
      SELECT piece_technique_id,$2::uuid,phase,nom,designation,article_id,fournisseur_id,fournisseur_nom,quantite,quantite_pieces,pu_achat,unite_prix,type_achat
      FROM public.pieces_techniques_achats WHERE piece_technique_id=$1::uuid AND piece_technique_version_id IS NOT DISTINCT FROM $3::uuid`,
      [of.piece_technique_id, of.version_id, input.source_version_id],
    );
    if (!copied.rowCount)
      throw new HttpError(
        422,
        "PURCHASE_SOURCE_EMPTY",
        "Aucun achat à reprendre dans cette source.",
      );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.purchases.import",
      {
        source_version_id: input.source_version_id,
        target_version_id: of.version_id,
        count: copied.rowCount,
      },
    );
    return persistPreparationEvaluation(tx, id);
  });
}
