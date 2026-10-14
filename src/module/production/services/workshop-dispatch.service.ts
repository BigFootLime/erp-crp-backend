import { HttpError } from "../../../utils/httpError";
import { insertAuditLog, type AuditContext } from "../../project-office/repository/project-office.repository";
import { readOfDossierTx } from "../repository/of-dossier.repository";
import * as documents from "../repository/of-versioning.repository";
import * as jobs from "../repository/workshop-dispatch.repository";
import { prepareWorkshopFolder, printWorkshopFolder } from "./workshop-folder.service";
import type { OfActor } from "./of-versioning.service";
function assertOwner(job: jobs.WorkshopDispatchJob, actorId: number, deviceId: string) {
  if (job.claimed_by !== actorId || job.device_id !== deviceId) throw new HttpError(409, "WORKSHOP_JOB_CLAIMED", "Ce dossier est pris en charge par un autre poste.");
}
async function assertCurrent(tx: documents.DbQueryer, job: jobs.WorkshopDispatchJob) {
  const root = (await tx.query<{ hash: string; rank: number }>(`SELECT o.technical_snapshot_sha256 AS hash,
    COALESCE((SELECT revision_rank FROM public.of_revisions WHERE of_id=o.id AND statut='ACTIVE'),0)::int AS rank
    FROM public.ordres_fabrication o WHERE o.id=$1`, [job.of_id])).rows[0];
  const dossier = await readOfDossierTx(tx, job.of_id);
  if (!root || root.hash !== job.technical_sha256 || root.rank !== job.revision_rank ||
    dossier.status !== "COMPLETE" || dossier.planning.planned === 0 || ["ANNULE", "ARCHIVE"].includes(dossier.executionStatus)) {
    throw new HttpError(409, "WORKSHOP_JOB_CHANGED", "L’OF ou son planning a changé. Vérifiez sa préparation.");
  }
}
async function scopedJob(id: string) {
  const job = await jobs.readWorkshopDispatchJob(id);
  if (!job) throw new HttpError(404, "WORKSHOP_JOB_NOT_FOUND", "Dossier à imprimer introuvable.");
  return job;
}
export async function claimWorkshopDispatchJob(id: string, deviceId: string, actor: OfActor, audit: AuditContext) {
  const initial = await scopedJob(id);
  try {
    return await documents.withOfTransaction(async tx => {
      await documents.lockOf(tx, initial.of_id);
      const job = (await jobs.readWorkshopDispatchJob(id, tx, true))!;
      if (job.claimed_by !== null) { assertOwner(job, actor.userId!, deviceId); return job; }
      await assertCurrent(tx, job);
      await jobs.claimWorkshopDispatch(tx, id, actor.userId!, deviceId);
      await insertAuditLog(tx, audit, { action: "OF_WORKSHOP_DISPATCH_CLAIM", entity_type: "of", entity_id: String(job.of_id),
        details: { job_id: id, device_id: deviceId, physical_print_confirmed: false } });
      return (await jobs.readWorkshopDispatchJob(id, tx))!;
    });
  } catch (error) {
    if (!(error instanceof documents.OfCommitUncertainError)) throw error;
    const saved = await scopedJob(id); assertOwner(saved, actor.userId!, deviceId); return saved;
  }
}
export async function printWorkshopDispatchJob(id: string, deviceId: string, actor: OfActor, audit: AuditContext) {
  const job = await scopedJob(id); assertOwner(job, actor.userId!, deviceId);
  if (job.state === "SPOOLED") throw new HttpError(409, "WORKSHOP_JOB_ALREADY_SPOOLED", "Ce dossier a déjà été envoyé à l’imprimante.");
  // Preparation failures preserve the claim and create no accepted print ordinal.
  const prepared = await prepareWorkshopFolder(job.of_id, `dispatch-prepare:${id}`, actor, audit);
  return printWorkshopFolder(job.of_id, prepared.folder.id, `dispatch-print:${id}`, actor.userId!, audit, async (tx, intent, folderId) => {
    const current = (await jobs.readWorkshopDispatchJob(id, tx, true))!;
    assertOwner(current, actor.userId!, deviceId);
    await assertCurrent(tx, current);
    if (intent.document_status !== "OFFICIEL" || (current.print_intent_id && current.print_intent_id !== intent.id) ||
      (current.folder_id && current.folder_id !== folderId)) throw new HttpError(409, "WORKSHOP_JOB_CHANGED", "L’exemplaire de ce dossier doit être vérifié.");
    await jobs.bindWorkshopDispatch(tx, id, intent.id, folderId);
  });
}
export async function acknowledgeWorkshopDispatchJob(id: string, deviceId: string, intentId: string, outcome: "SPOOLED" | "FAILED" | "UNCERTAIN", actorId: number, audit: AuditContext) {
  const initial = await scopedJob(id);
  return documents.withOfTransaction(async tx => {
    await documents.lockOf(tx, initial.of_id);
    const job = (await jobs.readWorkshopDispatchJob(id, tx, true))!;
    assertOwner(job, actorId, deviceId);
    if (job.print_intent_id !== intentId || !job.folder_id) throw new HttpError(409, "WORKSHOP_JOB_COPY_MISMATCH", "L’accusé ne correspond pas à ce dossier.");
    const fresh = await jobs.acknowledgeWorkshopDispatch(tx, job, actorId, deviceId, outcome);
    if (fresh) await insertAuditLog(tx, audit, { action: "OF_WORKSHOP_DISPATCH_RECEIPT", entity_type: "of", entity_id: String(job.of_id),
      details: { job_id: id, print_intent_id: intentId, device_id: deviceId, outcome, physical_print_confirmed: false } });
    return { state: job.state === "SPOOLED" || outcome === "SPOOLED" ? "SPOOLED" : "REVIEW", replayed: !fresh };
  });
}
