import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { consumableCommand } from "../../production/repository/consumable-command.repository";
import type { AuditContext } from "./receptions.repository";
import { processingEvent } from "./receipt-processing.repository";
type Queryable = Pick<PoolClient, "query">;
export async function readReceiptSubcontract(tx: Queryable, lineId: string) {
  const context = (
    await tx.query<{
      type: string | null;
      lot_id: string | null;
      line_id: string | null;
    }>(
      `SELECT cl.type,l.lot_id::text,cl.id::text AS line_id FROM public.reception_fournisseur_lignes l LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id WHERE l.id=$1::uuid`,
      [lineId],
    )
  ).rows[0];
  if (context?.type !== "SOUS_TRAITANCE") return null;
  const links = (
    await tx.query(
      `SELECT b.id::text,b.package_id::text,b.return_event_id::text,b.issue_event_id::text,b.quantity::float8,
    i.lot_id::text AS source_lot_id,lot.lot_code AS source_lot_code,p.of_operation_id::text,o.of_id
    FROM public.reception_subcontract_origins b JOIN public.subcontract_work_package_ledger i ON i.id=b.issue_event_id
    JOIN public.lots lot ON lot.id=i.lot_id JOIN public.subcontract_work_packages p ON p.id=b.package_id
    JOIN public.of_operations o ON o.id=p.of_operation_id WHERE b.receipt_line_id=$1::uuid`,
      [lineId],
    )
  ).rows;
  const options = (
    await tx.query(
      `SELECT p.id::text AS package_id,p.of_operation_id::text,o.of_id,p.unit,i.id::text AS issue_event_id,i.lot_id::text,lot.lot_code,
    (i.qty-COALESCE((SELECT sum(b.quantity) FROM public.reception_subcontract_origins b WHERE b.issue_event_id=i.id),0))::float8 AS available,
    (SELECT COALESCE(sum(e.qty) FILTER(WHERE e.event_type='ISSUE'),0)-COALESCE(sum(e.qty) FILTER(WHERE e.event_type='RETURN'),0) FROM public.subcontract_work_package_ledger e WHERE e.package_id=p.id)::float8 AS outstanding
    FROM public.subcontract_work_packages p JOIN public.of_operations o ON o.id=p.of_operation_id
    JOIN public.subcontract_work_package_ledger i ON i.package_id=p.id AND i.event_type='ISSUE' JOIN public.lots lot ON lot.id=i.lot_id
    WHERE p.supplier_order_line_id=$1::uuid AND p.status='SENT' ORDER BY i.created_at,i.id`,
      [context.line_id],
    )
  ).rows;
  const returns = (
    await tx.query<{
      id: string;
      lot_code: string;
      available: number;
      package_id: string;
      unit: string;
    }>(
      `SELECT e.id::text,lot.lot_code,e.package_id::text,e.unit,
    (e.qty-COALESCE((SELECT sum(b.quantity) FROM public.reception_subcontract_origins b WHERE b.return_event_id=e.id),0))::float8 AS available
    FROM public.subcontract_work_package_ledger e JOIN public.subcontract_work_packages p ON p.id=e.package_id JOIN public.lots lot ON lot.id=e.lot_id
    WHERE p.supplier_order_line_id=$1::uuid AND e.event_type='RETURN' ORDER BY e.created_at,e.id`,
      [context.line_id],
    )
  ).rows.filter((event) => event.available > 0);
  return { required: true, linked: links.length > 0, links, options, returns };
}
export async function assertReceiptSubcontractLinked(
  tx: Queryable,
  lineId: string,
) {
  const context = await readReceiptSubcontract(tx, lineId);
  if (context && !context.linked)
    throw new HttpError(
      409,
      "SUBCONTRACT_RECEIPT_ORIGINS_REQUIRED",
      "Rattachez ce retour au dossier de sous-traitance et aux lots réellement expédiés.",
    );
}
export async function bindReceiptSubcontract(
  receptionId: string,
  lineId: string,
  body: {
    idempotencyKey: string;
    expectedVersion: number;
    returnEventId?: string;
    origins: Array<{ issueEventId: string; quantity: number }>;
  },
  audit: AuditContext,
) {
  const payload = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "RECEIPT_SUBCONTRACT_RETURN",
    payload,
    audit,
    async (tx) => {
      const line = (
        await tx.query<{
          lot_id: string;
          qty: number;
          unit: string;
          version: number;
          status: string;
        }>(
          `SELECT l.lot_id::text,l.qty_received::float8 AS qty,l.unite AS unit,l.processing_version AS version,r.status FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id WHERE l.id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF l,r`,
          [lineId, receptionId],
        )
      ).rows[0];
      if (
        !line ||
        line.status !== "OPEN" ||
        line.version !== body.expectedVersion
      )
        throw new HttpError(
          409,
          "RECEIPT_PROCESSING_CHANGED",
          "Relisez la réception ouverte avant de confirmer.",
        );
      if (!line.lot_id)
        throw new HttpError(
          409,
          "RECEIPT_LOT_REQUIRED",
          "Identifiez le lot reçu.",
        );
      // Lock packages before recomputing custody so two receivers cannot allocate
      // the same dispatched quantity, including through the old return route.
      await tx.query(
        `SELECT p.id FROM public.subcontract_work_packages p JOIN public.reception_fournisseur_lignes r ON r.commande_fournisseur_ligne_id=p.supplier_order_line_id WHERE r.id=$1::uuid ORDER BY p.id FOR UPDATE OF p`,
        [lineId],
      );
      const context = await readReceiptSubcontract(tx, lineId);
      if (!context || context.linked)
        throw new HttpError(
          409,
          "SUBCONTRACT_RECEIPT_ALREADY_LINKED",
          "Ce retour est déjà rattaché ou ne concerne pas une sous-traitance.",
        );
      if (
        Math.abs(body.origins.reduce((s, o) => s + o.quantity, 0) - line.qty) >
        0.000001
      )
        throw new HttpError(
          422,
          "SUBCONTRACT_RETURN_TOTAL",
          "Les origines doivent couvrir exactement la quantité reçue.",
        );
      const grouped = new Map<string, number>();
      for (const origin of body.origins) {
        const item = context.options.find(
          (o) => o.issue_event_id === origin.issueEventId,
        );
        if (
          !item ||
          item.unit?.trim().toUpperCase() !== line.unit?.trim().toUpperCase() ||
          origin.quantity > item.available + 0.000001
        )
          throw new HttpError(
            409,
            "SUBCONTRACT_RETURN_ORIGIN_INVALID",
            "Le lot expédié, la quantité ou l’unité ne correspond pas au dossier.",
          );
        grouped.set(
          item.package_id,
          (grouped.get(item.package_id) ?? 0) + origin.quantity,
        );
      }
      for (const [packageId, qty] of grouped) {
        const existing = body.returnEventId
          ? context.returns.find(
              (event) =>
                event.id === body.returnEventId &&
                event.package_id === packageId,
            )
          : null;
        if (
          body.returnEventId &&
          (!existing ||
            qty > existing.available + 0.000001 ||
            existing.unit.trim().toUpperCase() !==
              line.unit.trim().toUpperCase())
        )
          throw new HttpError(
            409,
            "SUBCONTRACT_RETURN_EVIDENCE_INVALID",
            "Le retour déjà enregistré ne couvre pas cette réception dans le même dossier et la même unité.",
          );
        if (
          !existing &&
          qty >
            context.options.find((o) => o.package_id === packageId)!
              .outstanding +
              0.000001
        )
          throw new HttpError(
            409,
            "SUBCONTRACT_OVER_RETURN",
            "Retour supérieur au solde expédié.",
          );
        const event =
          existing ??
          (
            await tx.query(
              `INSERT INTO public.subcontract_work_package_ledger(package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) VALUES($1::uuid,'RETURN',$2::uuid,$3,$4,$5,$6) RETURNING id::text`,
              [
                packageId,
                line.lot_id,
                qty,
                line.unit,
                `${body.idempotencyKey}:${packageId}`,
                audit.user_id,
              ],
            )
          ).rows[0];
        for (const origin of body.origins) {
          const item = context.options.find(
            (o) => o.issue_event_id === origin.issueEventId,
          )!;
          if (item.package_id !== packageId) continue;
          await tx.query(
            `INSERT INTO public.reception_subcontract_origins(receipt_line_id,package_id,return_event_id,issue_event_id,quantity,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`,
            [
              lineId,
              packageId,
              event.id,
              origin.issueEventId,
              origin.quantity,
              audit.user_id,
            ],
          );
          await tx.query(
            `INSERT INTO public.stock_lot_genealogy_edges(parent_lot_id,child_lot_id,operation_type,qty_contributed,unit_code,correlation_id,created_by) VALUES($1::uuid,$2::uuid,'TRANSFORM',$3,$4,$5::uuid,$6)`,
            [
              item.lot_id,
              line.lot_id,
              origin.quantity,
              line.unit,
              randomUUID(),
              audit.user_id,
            ],
          );
        }
      }
      await processingEvent(tx, lineId, audit, "SUBCONTRACT_RETURN_LINKED", {
        origins: body.origins,
      });
      return readReceiptSubcontract(tx, lineId);
    },
  );
}
