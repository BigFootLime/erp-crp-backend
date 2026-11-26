import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { consumableCommand } from "../../production/repository/consumable-command.repository";
import { readVerifiedAutocontrolScan, type AutocontrolScanFile } from "../../qualite/repository/autocontrol-scan";
import type { AutocontrolProof } from "../../qualite/domain/autocontrol-proof";
import { insertQualityEvent, lockReceiptPlanQualification, type QualityActor } from "../../qualite/repository/quality-360.repository";
import { repoCreateNonConformityTx } from "../../qualite/repository/qualite.repository";
import { readPinnedWorkshopPaperScan, type PaperDepartureProof } from "../../subcontract/subcontract-paper-proof.repository";
import { readSubcontractReturnSources, SUBCONTRACT_RETURN_VERIFIED } from "../../subcontract/subcontract-return-proof.repository";
import type { SubcontractReturnControlBody } from "../validators/receipt-processing.validators";
import { processingEvent } from "./receipt-processing.repository";
import { readSubcontractOperatorReleaseContext, releaseVerifiedSubcontractReturn } from "./receipt-subcontract-operator-release.repository";

const commandType = "RECEIPT_SUBCONTRACT_RETURN_CONTROL";
type Queryable = Pick<PoolClient, "query">;

async function readReturnLine(tx: Queryable, receptionId: string, lineId: string, lock = false) {
  const line = (await tx.query<{ lotId: string | null; supplierId: string; status: string; version: number }>(
    "SELECT l.lot_id::text AS \"lotId\",r.fournisseur_id::text AS \"supplierId\",r.status,l.processing_version::int AS version " +
    "FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id " +
    "WHERE r.id=$1::uuid AND l.id=$2::uuid" + (lock ? " FOR UPDATE OF l,r" : ""),
    [receptionId, lineId],
  )).rows[0];
  if (!line) throw new HttpError(404, "RECEIPT_LINE_NOT_FOUND", "Ligne de réception introuvable.");
  return line;
}

export async function readReceiptReturnControl(receptionId: string, lineId: string, mayReceive: boolean) {
  const line = await readReturnLine(pool, receptionId, lineId);
  const details = await readSubcontractReturnSources(pool, lineId);
  const sources = details.map(source => ({
    issueId: source.issueId, quantity: source.quantity, unit: source.unit, lotCode: source.lotCode,
    proofs: source.proofs.map(proof => ({
      controlId: proof.controlId, operationId: proof.operationId, mode: proof.mode,
      confirmedAt: proof.confirmedAt, documentId: proof.documentId, measurements: proof.measurements,
    })),
    ...(source.recorded ? { recorded: {
      verdict: source.recorded.verdict, appearance: source.recorded.appearance, nonConformityId: source.recorded.nonConformityId,
    } } : {}),
  }));
  const pending = sources.some(source => !source.recorded);
  const formalQualityRequired = pending && !await readSubcontractOperatorReleaseContext(pool, lineId, details);
  return { version: line.version, canRecord: mayReceive && line.status === "OPEN" && pending,
    reopenRequired: mayReceive && line.status === "CLOSED" && pending, sources,
    ...(pending ? { formalQualityRequired } : {}) };
}

async function readPaperProof(tx: Queryable, proof: AutocontrolProof | PaperDepartureProof) {
  if ("source" in proof) return readPinnedWorkshopPaperScan(tx, proof);
  const doc = (await tx.query<AutocontrolScanFile>(
    "SELECT storage_path,mime_type,size_bytes::text,sha256 FROM public.quality_documents " +
    "WHERE id=$1::uuid AND entity_type='CONTROL' AND entity_id=$2::uuid AND removed_at IS NULL AND confidentiality<>'RESTRICTED'",
    [proof.documentId ?? null, proof.controlId],
  )).rows[0];
  if (!doc || doc.sha256?.toLowerCase() !== proof.documentSha256) {
    throw new HttpError(409, "SUBCONTRACT_RETURN_SCAN_UNAVAILABLE", "La fiche vérifiée au départ n’est plus disponible. Contactez Qualité.");
  }
  const { bytes } = await readVerifiedAutocontrolScan(doc, false);
  return { bytes, mimeType: doc.mime_type };
}

export async function readReceiptReturnDocument(receptionId: string, lineId: string, issueId: string, documentId: string) {
  await readReturnLine(pool, receptionId, lineId);
  const source = (await readSubcontractReturnSources(pool, lineId)).find(item => item.issueId === issueId);
  const proof = source?.proofs.find(item => item.mode === "PAPER" && item.documentId === documentId);
  if (!proof) throw new HttpError(404, "SUBCONTRACT_RETURN_SCAN_NOT_FOUND", "Fiche d’autocontrôle introuvable pour ce retour.");
  return readPaperProof(pool, proof);
}

export async function recordReceiptReturnControl(receptionId: string, lineId: string, body: SubcontractReturnControlBody, actor: QualityActor) {
  const command = { ...body, receptionId, lineId };
  return consumableCommand({}, commandType, command, actor, async tx => {
    const line = await readReturnLine(tx, receptionId, lineId, true);
    if (line.status !== "OPEN") throw new HttpError(409, "RECEIPT_NOT_OPEN", "Rouvrez le dossier de réception pour vérifier ce retour.");
    if (line.version !== body.expectedVersion) throw new HttpError(409, "RECEIPT_PROCESSING_CHANGED", "Relisez la ligne avant de confirmer le contrôle.");
    const source = (await readSubcontractReturnSources(tx, lineId)).find(item => item.issueId === body.sourceIssueId);
    if (!source || !line.lotId) throw new HttpError(409, "SUBCONTRACT_RETURN_PROOF_REQUIRED", "Rattachez le retour à son envoi avec autocontrôle vérifié.");
    if (source.recorded) throw new HttpError(409, "SUBCONTRACT_RETURN_CONTROL_EXISTS", "Ce retour a déjà été contrôlé.");

    const seen = new Set<string>();
    const measurements = body.measurements.map(measurement => {
      const key = [measurement.controlId, measurement.characteristicKey, measurement.sampleNo].join("/");
      const proof = source.proofs.find(item => item.controlId === measurement.controlId && item.mode === "DIGITAL");
      const reference = proof?.measurements.find(point => point.characteristicKey === measurement.characteristicKey &&
        point.sampleNo === measurement.sampleNo);
      if (seen.has(key) || !reference) throw new HttpError(422, "SUBCONTRACT_RETURN_MEASUREMENT_INVALID",
        "Choisissez une cote de l’autocontrôle d’origine et saisissez chaque cote une seule fois.");
      seen.add(key);
      const outOfBounds = (reference.minMm !== undefined && measurement.valueMm < reference.minMm - 1e-9) ||
        (reference.maxMm !== undefined && measurement.valueMm > reference.maxMm + 1e-9);
      return { ...measurement, reference, outOfBounds };
    });
    if (body.paperMeasurement && !source.proofs.some(proof => proof.mode === "PAPER")) {
      throw new HttpError(422, "SUBCONTRACT_RETURN_MEASUREMENT_INVALID", "Sélectionnez les cotes de l’autocontrôle numérique associé.");
    }
    if (body.verdict === "CONFORME" && (body.appearance === "NOK" || measurements.some(item => item.outOfBounds))) {
      throw new HttpError(422, "SUBCONTRACT_RETURN_VERDICT_INVALID", "Un aspect non conforme ou une cote hors tolérance doit être enregistré en non-conformité.");
    }
    if (body.verdict === "NON_CONFORME") {
      const paper = source.proofs.some(proof => proof.mode === "PAPER");
      const hasEvidence = paper ? !!body.paperMeasurement : body.appearance === "NOK" || measurements.length > 0;
      if (!body.comment || !hasEvidence) throw new HttpError(422, "SUBCONTRACT_RETURN_NONCONFORMITY_EVIDENCE_REQUIRED",
        paper ? "Renseignez une cote relevée sur la pièce et un commentaire." : "Décrivez le défaut et relevez la cote si l’aspect est conforme.");
    }
    for (const proof of source.proofs) {
      if (proof.mode === "PAPER") await readPaperProof(tx, proof);
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["quality-lot:" + line.lotId]);
    await tx.query("SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE", [line.lotId]);

    const measuredText = measurements.map(item => {
      const tolerance = [item.reference.minMm === undefined ? null : `mini ${item.reference.minMm}`,
        item.reference.maxMm === undefined ? null : `maxi ${item.reference.maxMm}`].filter(Boolean).join(", ");
      return `${item.reference.label}, échantillon ${item.sampleNo} : ${item.valueMm} mm (avant traitement ${item.reference.valueMm} mm${tolerance ? ", " + tolerance + " mm" : ""})${item.outOfBounds ? " · hors tolérance" : ""}`;
    });
    if (body.paperMeasurement) measuredText.unshift(`${body.paperMeasurement.label} : ${body.paperMeasurement.valueMm} mm (fiche manuscrite)`);
    const description = [body.comment, body.appearance === "NOK" ? "Aspect au retour non conforme" : "Aspect au retour conforme", ...measuredText]
      .filter(Boolean).join("\n").slice(0, 10_000);
    const nonConformityId = body.verdict === "NON_CONFORME" ? await repoCreateNonConformityTx(tx, { audit: actor, body: {
      of_id: source.ofId, of_operation_id: source.operationId, lot_id: line.lotId, reception_ligne_id: lineId,
      fournisseur_id: line.supplierId, status: "OPEN", severity: "MINOR", description,
    } }) : null;
    const result = { sourceIssueId: source.issueId, verdict: body.verdict, appearance: body.appearance, nonConformityId };
    const detail = { ...result, lineId, receptionId, lotId: line.lotId, measurements, paperMeasurement: body.paperMeasurement, comment: body.comment };
    await processingEvent(tx, lineId, actor, SUBCONTRACT_RETURN_VERIFIED, detail);
    const correlations = (await tx.query<{ id: string; correlation_id: string }>(
      "SELECT id::text,correlation_id::text FROM public.quality_control WHERE id=ANY($1::uuid[])",
      [source.proofs.flatMap(proof => proof.controlId ? [proof.controlId] : [])],
    )).rows;
    for (const control of correlations) {
      await insertQualityEvent(tx, { entity_type: "CONTROL", entity_id: control.id, event_type: SUBCONTRACT_RETURN_VERIFIED,
        actor, old_values: null, new_values: detail, correlation_id: control.correlation_id,
        idempotency_key: body.idempotencyKey, rule_code: "SUBCONTRACT_RETURN_OPERATOR" });
    }
    const all = body.verdict === "CONFORME" ? await readSubcontractReturnSources(tx, lineId) : [];
    if (!all.length || all.some(item => item.recorded?.verdict !== "CONFORME")) return result;
    await lockReceiptPlanQualification(tx);
    const scope = await readSubcontractOperatorReleaseContext(tx, lineId, all);
    const release = scope ? await releaseVerifiedSubcontractReturn(tx, {
      scope, lineId, idempotencyKey: body.idempotencyKey, sources: all, actor,
    }) : null;
    return { ...result, formalQualityRequired: !scope, releasedQuantity: release?.releasedQuantity ?? 0 };
  });
}
