import { assertDeliveryNoteTx } from "./receipt-delivery-note.repository";
import {receiptTransferred} from '../../subcontract/subcontract-receipt-allocation.repository';
import { transferMaterialReceiptTx } from "../../production/repository/of-material-receipts.repository";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { assertReceiptLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import {
  repoCreateMovement,
  repoPostMovement,
} from "../../stock/repository/stock.repository";
import {
  hashStockCommand,
  normalizeIdempotencyKey,
} from "../../stock/domain/stock-command";
import { assertStockingQuantity } from "../domain/receipt-processing";
import type { StockReceiptBodyDTO } from "../validators/receptions.validators";
import type { AuditContext } from "./receptions.repository";
import {
  readProcessingLine,
  assertProcessingWritable,
  processingEvent,
} from "./receipt-processing.repository";
import { assertReceiptSubcontractLinked } from "./receipt-subcontract.repository";

export async function postPieceReceiptStockTx(
  tx: PoolClient,
  receptionId: string,
  lineId: string,
  body: StockReceiptBodyDTO,
  audit: AuditContext,
  idempotencyKey: string,
) {
  const line = await readProcessingLine(tx, lineId, receptionId, true);
  assertProcessingWritable(
    line,
    body.expected_processing_version ?? line.version,
  );
  await assertReceiptSubcontractLinked(tx, lineId);
  assertStockingQuantity(line, body.qty);
  await assertDeliveryNoteTx(tx, receptionId);
  if (!line.stockArticleId || !line.lotId)
    throw new HttpError(
      409,
      "RECEIPT_MP_MAPPING_REQUIRED",
      "Associez la référence matière première avant la mise en stock.",
    );
  const target = (
    await tx.query<{ unite: string }>(
      `SELECT unite FROM public.articles WHERE id=$1::uuid AND article_category='matiere' AND stock_managed AND is_active FOR SHARE`,
      [line.stockArticleId],
    )
  ).rows[0];
  if (
    !target ||
    target.unite?.trim().toUpperCase() !== line.stockUnit?.trim().toUpperCase()
  )
    throw new HttpError(
      409,
      "RECEIPT_MP_TARGET_CHANGED",
      "La référence MP doit être active, stockée et conserver l’unité de réception convertie.",
    );
  if (
    body.unite &&
    body.unite.trim().toUpperCase() !== line.unit.trim().toUpperCase()
  )
    throw new HttpError(
      422,
      "RECEPTION_STOCK_INPUT_UNIT",
      "Saisissez la quantité dans l’unité de réception.",
    );
  await assertReceiptLotQualityEligibility({
    client: tx,
    lotId: line.lotId,
    receiptLineId: lineId,
    qty: (line.stocked + body.qty + await receiptTransferred(tx,lineId)) * line.coefficient,
    unit: line.stockUnit,
  });

  const pieces: Array<{
    packagingId: string;
    id: string;
    offset: number;
    lotId: string;
    quantity: number;
    stockQuantity: number;
  }> = [];
  let remaining = body.qty;
  for (const pack of line.packagings.filter((p) => !p.voidedAt)) {
    const quantity = Math.min(
      remaining,
      Math.max(0, pack.quantity - pack.stocked),
    );
    if (quantity <= 0.000001) continue;
    const lotCode = await generateTransactionalBusinessCode(tx, {
      prefix: "LOT",
    });
    const lot = (
      await tx.query<{ id: string }>(
        `INSERT INTO public.lots(article_id,lot_code,supplier_lot_code,received_at,notes,lot_status,lot_status_note,created_by,updated_by,client_proprietaire_id)
      SELECT $1::uuid,$2,source.supplier_lot_code,source.received_at,$3,'LIBERE',$4,$5,$5,source.client_proprietaire_id FROM public.lots source WHERE source.id=$6::uuid RETURNING id::text`,
        [
          line.stockArticleId,
          lotCode,
          `Réception ${line.receptionNumber} · emballage ${pack.id}`,
          "Portion contrôlée et emballée ; disponibilité bornée par sa quantité.",
          audit.user_id,
          line.lotId,
        ],
      )
    ).rows[0];
    if (!lot)
      throw new HttpError(
        409,
        "RECEIPT_SOURCE_LOT_MISSING",
        "Lot de réception introuvable.",
      );
    pieces.push({
      packagingId: pack.id,
      id: randomUUID(),
      offset: (body.qty - remaining) * line.coefficient,
      lotId: lot.id,
      quantity,
      stockQuantity: quantity * line.coefficient,
    });
    remaining -= quantity;
    if (remaining <= 0.000001) break;
  }
  if (remaining > 0.000001)
    throw new HttpError(
      409,
      "RECEIPT_PACKAGING_CHANGED",
      "La quantité emballée disponible a changé.",
    );
  const key = hashStockCommand("RECEPTION_STOCK_KEY", {
    actor_user_id: audit.user_id,
    idempotency_key: idempotencyKey,
  });
  const created = await repoCreateMovement(
    {
      movement_type: "IN",
      effective_at: body.effective_at ?? null,
      source_document_type: "RECEPTION_FOURNISSEUR",
      source_document_id: receptionId,
      reason_code: "RECEPTION_FOURNISSEUR",
      notes:
        body.notes ??
        `Pièces contrôlées et emballées · ${line.receptionNumber}`,
      idempotency_key: `rf-create-${key}`,
      lines: pieces.map((p) => ({
        article_id: line.stockArticleId!,
        lot_id: p.lotId,
        qty: p.stockQuantity,
        unite: line.stockUnit,
        unit_cost: null,
        currency: null,
        src_magasin_id: null,
        src_emplacement_id: null,
        dst_magasin_id: body.dst_magasin_id,
        dst_emplacement_id: body.dst_emplacement_id,
        note: null,
      })),
    },
    audit,
    { trusted_source_flow: true, client: tx },
  );
  for (const piece of pieces) {
    await tx.query(
      `INSERT INTO public.reception_stock_portions(id,receipt_stock_offset,receipt_line_id,packaging_id,source_lot_id,stock_lot_id,stock_movement_id,quantity,stock_quantity,created_by)
      VALUES($9::uuid,$10,$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8)`,
      [
        lineId,
        piece.packagingId,
        line.lotId,
        piece.lotId,
        created.movement.id,
        piece.quantity,
        piece.stockQuantity,
        audit.user_id,
        piece.id,
        piece.offset,
      ],
    );
    await tx.query(
      `INSERT INTO public.stock_lot_genealogy_edges(parent_lot_id,child_lot_id,operation_type,qty_contributed,unit_code,stock_movement_id,correlation_id,created_by)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8)`,
      [
        line.lotId,
        piece.lotId,
        line.articleId === line.stockArticleId ? "SPLIT" : "TRANSFORM",
        piece.stockQuantity,
        line.stockUnit,
        created.movement.id,
        randomUUID(),
        audit.user_id,
      ],
    );
  }
  const posted = await repoPostMovement(
    created.movement.id,
    {},
    audit,
    `rf-post-${key}`,
    tx,
  );
  if (!posted)
    throw new Error("The packaged receipt stock movement was not posted");
  const receiptInsert = await tx.query<{ id: string }>(
    `INSERT INTO public.reception_fournisseur_stock_receipts(reception_id,reception_line_id,stock_movement_id,qty,created_by,idempotency_key,request_hash)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) RETURNING id::text`,
    [
      receptionId,
      lineId,
      posted.movement.id,
      body.qty,
      audit.user_id,
      normalizeIdempotencyKey(idempotencyKey),
      hashStockCommand("RECEPTION_STOCK_RECEIPT", {
        receptionId,
        lineId,
        body,
      }),
    ],
  );
  for (const piece of pieces)
    await transferMaterialReceiptTx(
      tx,
      receiptInsert.rows[0].id,
      audit,
      piece.id,
    );
  await processingEvent(tx, lineId, audit, "STOCKED", {
    movementId: posted.movement.id,
    quantity: body.qty,
    stockArticleId: line.stockArticleId,
    portions: pieces,
  });
  return {
    stock_movement_id: posted.movement.id,
    movement_no: posted.movement.movement_no,
    posted,
  };
}
