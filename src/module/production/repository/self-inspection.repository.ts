import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import type { AuditContext } from "./production.repository";
import {
  assertPreparationMutable,
  evaluateOfPreparation,
  loadPreparationOrder,
  persistPreparationEvaluation,
  preparationAudit,
} from "./production-preparation.repository";
import {
  renderSelfInspectionPdf,
  type SelfInspectionSnapshot,
} from "../services/self-inspection-pdf";

export async function generateSelfInspectionTx(
  tx: Pick<PoolClient, "query">,
  ofId: number,
  expected: string,
  audit: AuditContext,
) {
  const of = await loadPreparationOrder(tx, ofId, true);
  assertPreparationMutable(of, expected);
  const evaluation = await evaluateOfPreparation(tx, ofId);
  if (evaluation.sheet?.state === "READY") return evaluation;
  const plan = evaluation.sources.quality_plan;
  if (
    !plan ||
    !evaluation.version ||
    !evaluation.sources.characteristics.length
  )
    throw new HttpError(
      422,
      "QUALITY_PLAN_REQUIRED",
      "Publiez un plan de contrôle avec ses caractéristiques pour cet indice.",
    );
  const snapshot: SelfInspectionSnapshot = {
    of,
    version: evaluation.version,
    plan,
    characteristics: evaluation.sources.characteristics,
    source_hash: evaluation.sheet_hash,
  };
  await tx.query(
    `INSERT INTO public.of_self_inspection_sheets(of_id,piece_technique_version_id,quality_plan_id,source_hash,snapshot,state,created_by)
      VALUES($1,$2::uuid,$3::uuid,$4,$5::jsonb,'PENDING',$6) ON CONFLICT(of_id,source_hash) DO UPDATE SET state='PENDING',error_code=NULL`,
    [
      ofId,
      of.version_id,
      plan.id,
      evaluation.sheet_hash,
      JSON.stringify(snapshot),
      audit.user_id,
    ],
  );
  let pdf: Buffer;
  try {
    pdf = await renderSelfInspectionPdf(snapshot);
  } catch {
    await tx.query(
      `UPDATE public.of_self_inspection_sheets SET state='FAILED',pdf=NULL,pdf_sha256=NULL,error_code='PDF_RENDER_FAILED' WHERE of_id=$1 AND source_hash=$2`,
      [ofId, evaluation.sheet_hash],
    );
    await preparationAudit(
      tx,
      audit,
      ofId,
      "production.preparation.self-inspection.failed",
      { source_hash: evaluation.sheet_hash },
    );
    return persistPreparationEvaluation(tx, ofId);
  }
  await tx.query(
    `UPDATE public.of_self_inspection_sheets SET state='READY',pdf=$3,pdf_sha256=$4,error_code=NULL WHERE of_id=$1 AND source_hash=$2`,
    [
      ofId,
      evaluation.sheet_hash,
      pdf,
      createHash("sha256").update(pdf).digest("hex"),
    ],
  );
  await tx.query(
    "UPDATE public.ordres_fabrication SET updated_at=now(),updated_by=$2 WHERE id=$1",
    [ofId, audit.user_id],
  );
  await preparationAudit(
    tx,
    audit,
    ofId,
    "production.preparation.self-inspection.generate",
    { source_hash: evaluation.sheet_hash, quality_plan_id: plan.id },
  );
  return persistPreparationEvaluation(tx, ofId);
}

export async function repoGenerateSelfInspection(
  ofId: number,
  expected: string,
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), (tx) =>
    generateSelfInspectionTx(tx, ofId, expected, audit),
  );
}

export async function repoDownloadSelfInspection(
  ofId: number,
  sheetId: string,
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    await loadPreparationOrder(tx, ofId);
    const sheet = (
      await tx.query<{ pdf: Buffer; pdf_sha256: string }>(
        `SELECT pdf,pdf_sha256 FROM public.of_self_inspection_sheets WHERE of_id=$1 AND id=$2::uuid AND state='READY'`,
        [ofId, sheetId],
      )
    ).rows[0];
    if (!sheet)
      throw new HttpError(
        404,
        "INSPECTION_SHEET_NOT_FOUND",
        "Fiche d’autocontrôle indisponible.",
      );
    if (
      createHash("sha256").update(sheet.pdf).digest("hex") !== sheet.pdf_sha256
    )
      throw new HttpError(
        409,
        "INSPECTION_SHEET_INTEGRITY",
        "L’intégrité du document ne peut pas être vérifiée.",
      );
    await preparationAudit(
      tx,
      audit,
      ofId,
      "production.preparation.self-inspection.download",
      { sheet_id: sheetId },
    );
    return sheet.pdf;
  });
}
