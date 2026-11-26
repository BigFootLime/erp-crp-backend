import pool from "../../../config/database";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { HttpError } from "../../../utils/httpError";
import { qualityRequestHash } from "../../qualite/domain/quality-policy";
import { repoCreateNonConformityTx } from "../../qualite/repository/qualite.repository";
import { acquireIdempotency, saveReceipt } from "../../qualite/repository/quality-command-receipt.repository";
import { applyMaterialLotDecision } from "../../qualite/repository/quality-material-lot-decision";
import { normalizeOperatorGrade } from "../domain/operator-control-dimensions";
import { convertedStockQuantity } from "../domain/receipt-unit-conversion";
import type { OperatorControlBody } from "../validators/receipt-processing.validators";
import type { AuditContext } from "./receptions.repository";
import { processingEvent, readProcessingLine } from "./receipt-processing.repository";
import { assertReceiptReleaseAvailable } from "./receipt-quality-release.repository";

const commandType = "receptions.operator-control";

type OperatorControlResult = {
  controlId: string;
  decisionId: string;
  nonConformityId: string | null;
  verdict: OperatorControlBody["verdict"];
  released: number;
  held: number;
  unit: string;
};

export async function recordReceiptOperatorControl(
  receptionId: string,
  lineId: string,
  body: OperatorControlBody,
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    const { idempotencyKey, ...input } = body;
    const request = { receptionId, lineId, ...input };
    const idem = await acquireIdempotency({ client: tx, actor: audit, idempotencyKeyRaw: idempotencyKey, commandType, requestPayload: request });
    if (idem.replay) return idem.replay as OperatorControlResult;
    const locked = (await tx.query<{ lotId: string | null; supplierId: string; status: string }>(
      `SELECT l.lot_id::text AS "lotId",r.fournisseur_id::text AS "supplierId",r.status
       FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
       WHERE l.id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF l,r`, [lineId, receptionId],
    )).rows[0];
    if (!locked) throw new HttpError(404, "RECEIPT_LINE_NOT_FOUND", "Ligne de réception introuvable.");

    if (locked.status !== "OPEN") throw new HttpError(409, "RECEIPT_NOT_OPEN", "Rouvrez le dossier de réception avant de saisir le contrôle.");
    if (!locked.lotId) throw new HttpError(409, "LOT_REQUIRED", "Identifiez le lot reçu avant son contrôle.");

    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`quality-lot:${locked.lotId}`]);
    await tx.query("SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE", [locked.lotId]);
    const line = await readProcessingLine(tx, lineId, receptionId);
    if (line.version !== body.expectedVersion) throw new HttpError(409, "RECEIPT_PROCESSING_CHANGED", "Relisez la ligne avant de confirmer son contrôle.");
    if (line.operatorControl?.kind !== body.kind || !line.articleId || !line.stockUnit) {
      throw new HttpError(409, "RECEIPT_OPERATOR_CONTROL_UNAVAILABLE", "Relisez le lot et ses exigences. Cette ligne ne peut pas suivre le contrôle opérateur.");
    }

    const population = convertedStockQuantity(line.received, line.coefficient);
    const conforming = body.verdict === "CONFORME";
    const released = conforming ? population : 0;
    const held = population - released;
    const referenceDimensions = line.operatorControl.dimensions;
    const receivedByLabel = new Map(body.measurements.map(item => [item.label, item]));
    if (body.measurements.length !== referenceDimensions.length || referenceDimensions.some(dimension => !receivedByLabel.has(dimension.label))) {
      throw new HttpError(422, "RECEIPT_CONTROL_DIMENSIONS_REQUIRED", "Vérifiez chaque dimension requise pour la forme de cette matière.");
    }
    const measurements = referenceDimensions.map(dimension => {
      const measured = receivedByLabel.get(dimension.label)!;
      const actual = Math.round(measured.valueMm * 1000);
      const mismatch = dimension.minimumMm !== undefined ? actual < Math.round(dimension.minimumMm * 1000) :
        dimension.valueMm !== null && actual !== Math.round(dimension.valueMm * 1000);
      return { ...measured, referenceMm: dimension.valueMm, minimumMm: dimension.minimumMm ?? null,
        result: mismatch ? "NOK" : measured.result ?? (dimension.valueMm !== null || dimension.minimumMm !== undefined ? "OK" : null) };
    });
    if (conforming && measurements.some(item => item.result === "NOK")) {
      throw new HttpError(422, "RECEIPT_CONTROL_DIMENSION_MISMATCH", "Une cote diffère de la référence. Enregistrez le constat non conforme.");
    }
    const referenceGrade = line.operatorControl.grade;
    if (referenceGrade && !body.grade) throw new HttpError(422, "RECEIPT_CONTROL_GRADE_REQUIRED", "Confirmez la nuance observée sur la matière.");
    const wrongGrade = !!(referenceGrade && body.grade && normalizeOperatorGrade(referenceGrade) !== normalizeOperatorGrade(body.grade.value));
    if (conforming && wrongGrade) throw new HttpError(422, "RECEIPT_CONTROL_GRADE_MISMATCH", "La nuance observée diffère de la référence. Enregistrez le constat non conforme.");
    const evidence = {
      source: "RECEIPT_OPERATOR_CONTROL", receptionId, lineId, lotId: locked.lotId, articleId: line.articleId,
      kind: body.kind, verdict: body.verdict, measurements, note: body.note ?? null,
      grade: body.grade ? { ...body.grade, reference: referenceGrade ?? null } : null,
      population, unit: line.stockUnit, expectedVersion: body.expectedVersion,
    };
    const proofSha256 = qualityRequestHash(commandType, evidence);
    await assertReceiptReleaseAvailable(tx, { id: lineId, quantity: population, unit: line.stockUnit }, released, line.stockUnit);

    const reference = await generateTransactionalBusinessCode(tx, { prefix: "CQ" });
    const control = (await tx.query<{ id: string; correlationId: string }>(
      `INSERT INTO public.quality_control
       (reference,control_type,status,result,controlled_by,validated_by,validation_date,source_type,source_id,trigger_type,
        lot_id,article_id,fournisseur_id,reception_ligne_id,unite,qty_population,qty_controlled,qty_conforming,qty_released,qty_held,
        verdict,comments,created_by,updated_by,operator_receipt_control)
       VALUES ($1,'RECEPTION',$2::public.quality_control_status,$3::public.quality_control_result,$4,$4,now(),'LOT',$5::text,'RECEPTION',
               $5::text::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$10,$11,$11,$12,$13,$14,$4,$4,true)
       RETURNING id::text,correlation_id::text AS "correlationId"`,
      [reference, conforming ? "VALIDATED" : "REJECTED", conforming ? "OK" : "NOK", audit.user_id, locked.lotId,
        line.articleId, locked.supplierId, lineId, line.stockUnit, population, released, held, body.verdict, body.note ?? null],
    )).rows[0];

    for (const [index, measurement] of measurements.entries()) {
      await tx.query(
        `INSERT INTO public.quality_control_points(quality_control_id,characteristic,characteristic_key,sample_no,
           measured_value,nominal_value,tolerance_min,unit,result,measured_at,recorded_by)
         VALUES ($1::uuid,$2,$3,1,$4,$5,$6,'mm',$7::public.quality_point_result,now(),$8)`,
        [control.id, measurement.label, `RECEPTION-COTE-${index + 1}`, measurement.valueMm, measurement.referenceMm,
          measurement.minimumMm, measurement.result, audit.user_id],
      );
    }
    if (body.grade) {
      await tx.query(
        `INSERT INTO public.quality_control_points(quality_control_id,characteristic,characteristic_key,sample_no,
           value_text,result,measured_at,recorded_by)
         VALUES ($1::uuid,'Nuance','RECEPTION-NUANCE',1,$2,$3::public.quality_point_result,now(),$4)`,
        [control.id, body.grade.value, referenceGrade ? wrongGrade ? "NOK" : "OK" : null, audit.user_id],
      );
    }
    const decision = conforming ? "FULL" : "REJECT";
    const { id: decisionId } = (await tx.query<{ id: string }>(
      `INSERT INTO public.quality_release_decision (quality_control_id,decision,object_type,object_id,qty,unite,verdict,
         justification,decided_by,executed_by,preview_sha256,idempotency_key,correlation_id)
       VALUES ($1::uuid,$2,'LOT',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11::uuid) RETURNING id::text`,
      [control.id, decision, locked.lotId, population, line.stockUnit, body.verdict, body.note ?? null,
        audit.user_id, proofSha256, idem.idempotencyKey, control.correlationId],
    )).rows[0];
    await applyMaterialLotDecision(tx, {
      execution: { id: control.id, lot_id: locked.lotId, source_type: "LOT", source_id: locked.lotId, trigger_type: "RECEPTION", correlation_id: control.correlationId },
      decision, released, unit: line.stockUnit, actorId: audit.user_id, decisionId,
    });

    const nonConformityId = conforming ? null : await repoCreateNonConformityTx(tx, {
      audit,
      body: { control_id: control.id, lot_id: locked.lotId, reception_ligne_id: lineId, fournisseur_id: locked.supplierId,
        description: body.note!, severity: "MINOR", status: "OPEN" },
    });
    const result: OperatorControlResult = { controlId: control.id, decisionId, nonConformityId, verdict: body.verdict, released, held, unit: line.stockUnit };
    await processingEvent(tx, lineId, audit, "OPERATOR_CONTROL_RECORDED", { ...evidence, ...result, proofSha256 });
    await saveReceipt({ client: tx, actor: audit, idempotencyKey: idem.idempotencyKey, requestHash: idem.requestHash, commandType,
      aggregateType: "CONTROL", aggregateId: control.id, requestPayload: request, resultPayload: result, correlationId: control.correlationId });
    return result;
  });
}
