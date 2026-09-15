import pool from "../../config/database";
import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { withPlanningCommand } from "../planning/repository/planning-command.repository";
import { buildAuditContext } from "../planning/controllers/planning.controller";
import {
  readSubcontractFlows,
  subcontractFlowInstalled,
} from "./subcontract-flow.repository";
import { assertReceiptLotQualityEligibility } from "../qualite/repository/quality-operational-gate.repository";
import type { SubcontractTransferInput } from "./subcontract-flow.validators";

export async function readSubcontractSuccessors(
  tx: Pick<PoolClient, "query">,
  operationId: string,
) {
  return (
    await tx.query<{ id: string; label: string; minimum: number | null }>(
      `WITH route AS(
    SELECT id,of_id,phase,lead(id) OVER(PARTITION BY of_id ORDER BY phase,id) AS next
    FROM public.of_operations op WHERE status::text<>'CANCELLED' AND
      (revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE')))
    SELECT target.id::text,target.designation AS label,d.transfer_quantity::float8 AS minimum
    FROM route source JOIN public.of_operations target ON target.of_id=source.of_id AND target.status::text<>'CANCELLED'
    LEFT JOIN public.planning_operation_dependencies d ON d.predecessor_id='op:'||source.id::text AND d.successor_id='op:'||target.id::text
    WHERE source.id=$1::uuid AND (d.successor_id IS NOT NULL OR(target.id=source.next AND NOT EXISTS(
      SELECT 1 FROM public.planning_operation_dependencies e WHERE e.successor_id='op:'||target.id::text AND e.predecessor_id LIKE 'op:%')))
      AND(target.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=target.revision_id AND r.statut='ACTIVE'))
    ORDER BY target.phase,target.id`,
      [operationId],
    )
  ).rows;
}

export async function getSubcontractFlow(packageId: string) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (!(await subcontractFlowInstalled(tx)))
      throw new HttpError(
        409,
        "SUBCONTRACT_FLOW_NOT_INSTALLED",
        "Le raccordement des retours au planning doit être installé.",
      );
    const p = (
      await tx.query(
        "SELECT of_operation_id,supplier_order_line_id FROM public.subcontract_work_packages WHERE id=$1::uuid",
        [packageId],
      )
    ).rows[0];
    if (!p)
      throw new HttpError(
        404,
        "SUBCONTRACT_PACKAGE_NOT_FOUND",
        "Dossier introuvable.",
      );
    const flow = (await readSubcontractFlows(tx, [p.of_operation_id])).find(
      (p) => p.packageId === packageId,
    );
    const receipts = (
      await tx.query(
        `SELECT rl.id::text,r.reception_no AS label,rl.lot_id::text,l.lot_code,rl.unite AS unit,
      GREATEST(0,rl.qty_received-COALESCE((SELECT sum(e.quantity) FROM public.reception_subcontract_origins e WHERE e.receipt_line_id=rl.id),0))::float8 AS remaining,
      r.id::text AS reception_id
      FROM public.reception_fournisseur_lignes rl JOIN public.receptions_fournisseurs r ON r.id=rl.reception_id
      JOIN public.lots l ON l.id=rl.lot_id WHERE rl.commande_fournisseur_ligne_id=$1::uuid AND l.lot_status='QUARANTAINE'
      ORDER BY r.reception_date,rl.id`,
        [p.supplier_order_line_id],
      )
    ).rows;
    const successors = await readSubcontractSuccessors(tx, p.of_operation_id);
    await tx.query("COMMIT");
    return { flow: flow ?? null, receipts, successors };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export async function getSubcontractCreationOptions(
  ofId?: number,
  lineId?: string,
) {
  const lines = (
    await pool.query(
      `SELECT l.id::text,l.of_id AS "ofId",cf.code||' · '||l.designation AS label,l.unite AS unit,l.quantite::float8 AS quantity,p.id::text AS "packageId"
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur cf ON cf.id=l.commande_id
    LEFT JOIN public.subcontract_work_packages p ON p.supplier_order_line_id=l.id
    WHERE l.type='SOUS_TRAITANCE' AND l.statut_ligne='ACTIVE' AND cf.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
      AND (($1::bigint IS NOT NULL AND l.of_id=$1) OR ($2::uuid IS NOT NULL AND l.commande_id=(SELECT commande_id FROM public.commande_fournisseur_ligne WHERE id=$2)))
    ORDER BY cf.code,l.id`,
      [ofId ?? null, lineId ?? null],
    )
  ).rows;
  const operations = (
    await pool.query(
      `SELECT op.id::text,op.of_id AS "ofId",op.phase||' · '||op.designation AS label
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    LEFT JOIN public.pieces_techniques_operations source ON source.id=op.source_piece_operation_id
    LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
    WHERE op.of_id=ANY($1::bigint[]) AND op.status::text<>'CANCELLED'
      AND COALESCE(frozen.value->>'type_operation',source.type_operation)='SOUS_TRAITANCE'
      AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE')) ORDER BY op.of_id,op.phase`,
      [lines.map((l) => l.ofId)],
    )
  ).rows;
  return { lines, operations };
}

export async function transferSubcontractReturn(
  packageId: string,
  input: SubcontractTransferInput,
  audit: ReturnType<typeof buildAuditContext>,
  key: string,
) {
  return withPlanningCommand(
    audit,
    key,
    "subcontract.transfer",
    { packageId, ...input },
    async (tx) => {
      if (
        (
          await tx.query(
            "SELECT value_text FROM public.erp_settings WHERE key='subcontract.flow_enabled'",
          )
        ).rows[0]?.value_text === "false"
      )
        throw new HttpError(
          409,
          "SUBCONTRACT_FLOW_PAUSED",
          "Les transferts de sous-traitance sont suspendus. Leur historique est conservé.",
        );
      await tx.query(
        "SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE",
      );
      const p = (
        await tx.query(
          `SELECT p.*,o.quantite_lancee,o.statut::text AS of_status FROM public.subcontract_work_packages p
      JOIN public.of_operations op ON op.id=p.of_operation_id JOIN public.ordres_fabrication o ON o.id=op.of_id
      WHERE p.id=$1::uuid FOR UPDATE OF p,o`,
          [packageId],
        )
      ).rows[0];
      if (
        !p ||
        p.status === "CANCELLED" ||
        ["ANNULE", "TERMINE", "CLOTURE"].includes(p.of_status)
      )
        throw new HttpError(
          409,
          "SUBCONTRACT_TRANSFER_UNAVAILABLE",
          "Ce dossier ne permet plus de transfert.",
        );
      const source = (
        await tx.query(
          `SELECT rl.lot_id,e.receipt_line_id FROM public.reception_subcontract_origins e
      JOIN public.reception_fournisseur_lignes rl ON rl.id=e.receipt_line_id
      WHERE e.id=$1::uuid AND e.package_id=$2::uuid FOR UPDATE OF e,rl`,
          [input.return_id, packageId],
        )
      ).rows[0];
      if (!source?.receipt_line_id)
        throw new HttpError(
          409,
          "SUBCONTRACT_RETURN_EVIDENCE_REQUIRED",
          "Le retour doit être rattaché à sa réception.",
        );
      await tx.query(
        "SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE",
        [source.lot_id],
      );
      const flow = (await readSubcontractFlows(tx, [p.of_operation_id])).find(
        (f) => f.packageId === packageId,
      )!;
      if (flow.version !== input.expected_version)
        throw new HttpError(
          409,
          "SUBCONTRACT_FLOW_CHANGED",
          "Les retours ou la qualité ont changé. Actualisez avant de transférer.",
        );
      const returned = flow.returns.find((r) => r.id === input.return_id)!;
      const successor = (
        await readSubcontractSuccessors(tx, p.of_operation_id)
      ).find((s) => s.id === input.successor_operation_id);
      if (!successor)
        throw new HttpError(
          422,
          "SUBCONTRACT_SUCCESSOR_INVALID",
          "Choisissez une opération suivante de la gamme active.",
        );
      if (input.action === "RELEASE") {
        const all = await readSubcontractFlows(tx, [p.of_operation_id]);
        const released = all.reduce((n, f) => n + f.released, 0);
        if (successor.minimum === null && released < Number(p.quantite_lancee))
          throw new HttpError(
            409,
            "SUBCONTRACT_FULL_RETURN_REQUIRED",
            "La gamme exige le retour conforme complet avant transfert.",
          );
        if (input.quantity > returned.transferable)
          throw new HttpError(
            409,
            "SUBCONTRACT_TRANSFER_QUANTITY_EXCEEDED",
            "La quantité dépasse le retour conforme encore disponible.",
          );
        // Lock and re-evaluate the actual receipt decision; a newer quarantine cannot race this transfer.
        await assertReceiptLotQualityEligibility({
          client: tx,
          lotId: source.lot_id,
          receiptLineId: source.receipt_line_id,
          qty: returned.transferred + input.quantity,
          unit: p.unit,
        });
        // A threshold gates downstream execution, not the accumulation of lots.
        // Several individually smaller returns may together reach that threshold.
        await tx.query(
          `INSERT INTO public.production_transfer_batches(operation_id,successor_operation_id,quantity,released_quantity,subcontract_origin_id,created_by)
        VALUES($1,$2,$3,$3,$4,$5)`,
          [
            p.of_operation_id,
            successor.id,
            input.quantity,
            input.return_id,
            audit.user_id,
          ],
        );
      } else {
        const downstream = (
          await tx.query(
            `SELECT op.status::text,COALESCE((SELECT sum(qty_good+qty_scrap+qty_rework+qty_pending_control)
        FROM public.production_quantity_declarations WHERE operation_id=op.id),0)::float8 AS processed
        FROM public.of_operations op WHERE id=$1::uuid FOR UPDATE`,
            [successor.id],
          )
        ).rows[0];
        if (
          ["RUNNING", "DONE"].includes(downstream.status) ||
          downstream.processed > 0
        )
          throw new HttpError(
            409,
            "SUBCONTRACT_TRANSFER_ALREADY_USED",
            "L’étape suivante a commencé : traiter sa correction avant le retour.",
          );
        const batches = (
          await tx.query(
            `SELECT id,released_quantity::float8 AS qty FROM public.production_transfer_batches
        WHERE subcontract_origin_id=$1::uuid AND successor_operation_id=$2::uuid AND released_quantity>0 ORDER BY created_at DESC,id DESC FOR UPDATE`,
            [input.return_id, successor.id],
          )
        ).rows;
        if (input.quantity > batches.reduce((n, b) => n + b.qty, 0))
          throw new HttpError(
            409,
            "SUBCONTRACT_TRANSFER_QUANTITY_EXCEEDED",
            "Le retour dépasse la quantité transférée.",
          );
        let left = input.quantity;
        for (const b of batches) {
          const take = Math.min(left, b.qty);
          if (!take) break;
          await tx.query(
            "UPDATE public.production_transfer_batches SET released_quantity=released_quantity-$2,version=version+1 WHERE id=$1",
            [b.id, take],
          );
          left -= take;
        }
      }
      await tx.query(
        `INSERT INTO public.erp_audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,$2,'SUBCONTRACT_WORK_PACKAGE',$3,$4::jsonb)`,
        [
          audit.user_id,
          "TRANSFER_" + input.action,
          packageId,
          JSON.stringify({ ...input, idempotency_key: key }),
        ],
      );
      return {
        package_id: packageId,
        action: input.action,
        quantity: input.quantity,
      };
    },
  );
}
