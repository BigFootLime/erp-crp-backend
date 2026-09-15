import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { readReceiptLotQualityEligibility } from "../qualite/repository/quality-operational-gate.repository";
import type {
  SubcontractFlow,
  SubcontractReturn,
} from "./subcontract-flow.types";
type Db = Pick<PoolClient, "query">;
type ReturnRow = {
  id: string;
  package_id: string;
  of_operation_id: string;
  receipt_line_id: string | null;
  receipt_number: string | null;
  lot_id: string;
  lot_code: string;
  qty: number;
  unit: string;
  returned_at: string;
  transferred: number;
};

export async function subcontractFlowInstalled(tx: Db) {
  return (
    (
      await tx.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='production_transfer_batches' AND column_name='subcontract_origin_id') AS installed`)
    ).rows[0]?.installed === true
  );
}

/** Returns remain WIP. Receipt and Quality own their physical and released quantities. */
export async function readSubcontractFlows(
  tx: Db,
  operationIds: string[],
): Promise<SubcontractFlow[]> {
  if (!operationIds.length || !(await subcontractFlowInstalled(tx))) return [];
  const packages = (
    await tx.query(
      `SELECT p.*,o.of_id,cf.fournisseur_id,COALESCE(f.nom,f.raison_sociale) AS supplier_name,cf.id AS order_id,cf.code AS order_code,
    COALESCE(l.date_promesse,cf.date_promesse)::text AS promised_date,
    CASE WHEN l.date_promesse IS NOT NULL THEN 'LINE' WHEN cf.date_promesse IS NOT NULL THEN 'ORDER' ELSE 'ESTIMATE' END AS promise_source,
    COALESCE(sum(e.qty) FILTER(WHERE e.event_type='ISSUE'),0)::float8 AS issued,
    COALESCE(sum(e.qty) FILTER(WHERE e.event_type='RETURN'),0)::float8 AS returned,
    min(e.created_at) FILTER(WHERE e.event_type='ISSUE') AS departed_at,
    (SELECT max(r.reception_date) FROM public.reception_subcontract_origins b
      JOIN public.reception_fournisseur_lignes rl ON rl.id=b.receipt_line_id
      JOIN public.receptions_fournisseurs r ON r.id=rl.reception_id WHERE b.package_id=p.id) AS last_return_at
    FROM public.subcontract_work_packages p JOIN public.of_operations o ON o.id=p.of_operation_id
    JOIN public.commande_fournisseur_ligne l ON l.id=p.supplier_order_line_id
    JOIN public.commande_fournisseur cf ON cf.id=l.commande_id JOIN public.fournisseurs f ON f.id=cf.fournisseur_id
    LEFT JOIN public.subcontract_work_package_ledger e ON e.package_id=p.id
    WHERE p.of_operation_id=ANY($1::uuid[]) AND p.status<>'CANCELLED'
    GROUP BY p.id,o.of_id,cf.id,f.nom,f.raison_sociale,l.date_promesse ORDER BY p.created_at,p.id`,
      [operationIds],
    )
  ).rows;
  // Include every return sharing these lots: a release entitlement cannot be reused by another package/OF.
  const rows = (
    await tx.query<ReturnRow>(
      `SELECT origin.id::text,origin.package_id::text,p.of_operation_id::text,origin.receipt_line_id::text,
    r.reception_no AS receipt_number,rl.lot_id::text,lot.lot_code,origin.quantity::float8 AS qty,rl.unite AS unit,
    r.reception_date::timestamptz::text AS returned_at,
    COALESCE((SELECT sum(b.released_quantity) FROM public.production_transfer_batches b WHERE b.subcontract_origin_id=origin.id),0)::float8 AS transferred
    FROM public.reception_subcontract_origins origin JOIN public.subcontract_work_packages p ON p.id=origin.package_id
    JOIN public.reception_fournisseur_lignes rl ON rl.id=origin.receipt_line_id
    JOIN public.lots lot ON lot.id=rl.lot_id JOIN public.receptions_fournisseurs r ON r.id=rl.reception_id
    WHERE origin.receipt_line_id IN(SELECT x.receipt_line_id FROM public.reception_subcontract_origins x
      JOIN public.subcontract_work_packages xp ON xp.id=x.package_id WHERE xp.of_operation_id=ANY($1::uuid[]))
    ORDER BY origin.created_at,origin.id`,
      [operationIds],
    )
  ).rows;
  const budget = new Map<string, number>(),
    reasons = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.receipt_line_id || budget.has(row.receipt_line_id)) continue;
    try {
      const q = await readReceiptLotQualityEligibility({
        client: tx,
        lotId: row.lot_id,
        receiptLineId: row.receipt_line_id,
        qty: 0,
        unit: row.unit,
      });
      const stocked = Number(
        (
          await tx.query(
            `SELECT COALESCE(sum(s.qty),0)::float8 AS qty FROM public.reception_fournisseur_stock_receipts s
        JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=$1::uuid AND m.status='POSTED'`,
            [row.receipt_line_id],
          )
        ).rows[0].qty,
      );
      budget.set(
        row.receipt_line_id,
        q.eligibility.blocks.length
          ? 0
          : Math.max(0, q.target.qty_released - stocked),
      );
      reasons.set(
        row.receipt_line_id,
        q.eligibility.blocks.map((b) => b.message),
      );
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      budget.set(row.receipt_line_id, 0);
      reasons.set(row.receipt_line_id, [e.message]);
    }
  }
  const returns: SubcontractReturn[] = rows.map((row) => {
    const released = row.receipt_line_id
      ? Math.min(row.qty, budget.get(row.receipt_line_id) ?? 0)
      : 0;
    if (row.receipt_line_id)
      budget.set(
        row.receipt_line_id,
        Math.max(0, (budget.get(row.receipt_line_id) ?? 0) - released),
      );
    return {
      id: row.id,
      packageId: row.package_id,
      operationId: row.of_operation_id,
      receiptLineId: row.receipt_line_id,
      receiptNumber: row.receipt_number,
      lotId: row.lot_id,
      lotCode: row.lot_code,
      quantity: Number(row.qty),
      returnedAt: new Date(row.returned_at).toISOString(),
      released,
      transferred: Number(row.transferred),
      transferable: Math.max(0, released - row.transferred),
      blockers: !row.receipt_line_id
        ? [
            "Rattacher ce retour historique à sa réception avant tout transfert.",
          ]
        : [
            ...(reasons.get(row.receipt_line_id) ?? []),
            ...(row.transferred > released
              ? [
                  "La qualité ne couvre plus les quantités transférées : vérifier les opérations suivantes.",
                ]
              : []),
          ],
    };
  });
  return packages.map((p) => {
    const own = returns.filter((r) => r.packageId === p.id);
    const flow = {
      packageId: p.id,
      operationId: p.of_operation_id,
      ofId: Number(p.of_id),
      supplierId: p.fournisseur_id,
      supplierName: p.supplier_name,
      orderId: p.order_id,
      orderCode: p.order_code,
      orderLineId: p.supplier_order_line_id,
      unit: p.unit,
      planned: Number(p.qty_planned),
      issued: Number(p.issued),
      returned: Number(p.returned),
      custody: Number(p.issued) - Number(p.returned),
      released: own.reduce((n, r) => n + r.released, 0),
      transferred: own.reduce((n, r) => n + r.transferred, 0),
      promisedDate: p.promised_date,
      promiseSource: p.promise_source,
      departedAt: p.departed_at ? new Date(p.departed_at).toISOString() : null,
      lastReturnAt: p.last_return_at
        ? new Date(p.last_return_at).toISOString()
        : null,
      status: p.status,
      returns: own,
    };
    return {
      ...flow,
      version: createHash("sha256").update(JSON.stringify(flow)).digest("hex"),
    };
  });
}

/** Effective release for one edge, capped again after any newer Quality decision. */
export async function readExternalTransfers(tx: Db, flows: SubcontractFlow[]) {
  const returns = flows.flatMap((p) => p.returns),
    byReturn = new Map(returns.map((r) => [r.id, r.released]));
  if (!returns.length) return [];
  const rows = (
    await tx.query<{
      id: string;
      operation_id: string;
      successor_operation_id: string;
      subcontract_origin_id: string;
      released_quantity: number;
      created_at: string;
    }>(
      `
    SELECT id::text,operation_id::text,successor_operation_id::text,subcontract_origin_id::text,released_quantity::float8,created_at::text
    FROM public.production_transfer_batches WHERE subcontract_origin_id=ANY($1::uuid[]) ORDER BY created_at,id`,
      [returns.map((r) => r.id)],
    )
  ).rows;
  return rows.map((row) => {
    const effective = Math.min(
      row.released_quantity,
      byReturn.get(row.subcontract_origin_id) ?? 0,
    );
    byReturn.set(
      row.subcontract_origin_id,
      Math.max(0, (byReturn.get(row.subcontract_origin_id) ?? 0) - effective),
    );
    return { ...row, effective };
  });
}
