import { assertDeliveryNoteTx } from "./receipt-delivery-note.repository";
import type { PoolClient } from "pg";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import pool from "../../../config/database";
import { parseIdentificationPayload } from "../../identification/domain/identification";
import { repoFindLabelByPublicId } from "../../identification/identification.repository";
import { HttpError } from "../../../utils/httpError";
import { consumableCommand } from "../../production/repository/consumable-command.repository";
import {
  readReceiptLotQualityEligibility,
  assertReceiptLotQualityEligibility,
} from "../../qualite/repository/quality-operational-gate.repository";
import {
  assertPackingQuantity,
  receiptProcessingState,
  type ReceiptProcessingPolicy,
} from "../domain/receipt-processing";
import type {
  PackReceiptBody,
  ProcessingQuery,
} from "../validators/receipt-processing.validators";
import type { AuditContext } from "./receptions.repository";
import {
  readReceiptSubcontract,
  assertReceiptSubcontractLinked,
} from "./receipt-subcontract.repository";

type Queryable = Pick<PoolClient, "query">;
export type ProcessingLine = {
  id: string;
  receptionId: string;
  receptionNumber: string;
  receiptStatus: string;
  policy: ReceiptProcessingPolicy;
  version: number;
  reconciliationRequired: boolean;
  toolId: number | null;
  stockManaged: boolean;
  qualityRequired: boolean;
  subcontract: Awaited<ReturnType<typeof readReceiptSubcontract>>;
  articleId: string;
  articleCode: string;
  designation: string;
  stockArticleId: string | null;
  stockArticleCode: string | null;
  supplierName: string;
  orderCode: string | null;
  lotId: string | null;
  lotCode: string | null;
  lotStatus: string | null;
  unit: string;
  stockUnit: string;
  coefficient: number;
  destinationMagasinId: string | null;
  destinationEmplacementId: number | null;
  received: number;
  accepted: number;
  packed: number;
  stocked: number;
  disposed: number;
  openNc: number;
  controlId: string | null;
  blocking: string[];
  stage: ReturnType<typeof receiptProcessingState>["stage"];
  queues: ReturnType<typeof receiptProcessingState>["queues"];
  packagings: Array<{
    id: string;
    quantity: number;
    stocked: number;
    packaging: string;
    packageCount: number;
    createdAt: string;
    voidedAt: string | null;
  }>;
};

export async function processingEvent(
  tx: Queryable,
  lineId: string,
  audit: AuditContext,
  event: string,
  details: unknown,
) {
  const recorded = await tx.query<{ id: string; created_at: string }>(
    `INSERT INTO public.reception_processing_events(receipt_line_id,event_type,details,actor_id) VALUES($1::uuid,$2,$3::jsonb,$4) RETURNING id::text,created_at::text`,
    [lineId, event, JSON.stringify(details), audit.user_id],
  );
  const receipt = await tx.query<{ reception_id: string }>(
    `UPDATE public.reception_fournisseur_lignes SET processing_version=processing_version+1,updated_at=now(),updated_by=$2 WHERE id=$1::uuid RETURNING reception_id::text`,
    [lineId, audit.user_id],
  );
  await enqueueEntityChanged(
    tx,
    {
      entityType: "RECEPTION",
      entityId: receipt.rows[0].reception_id,
      action: "updated",
      module: "receptions",
      at: recorded.rows[0].created_at,
      invalidateKeys: [
        "receptions:list",
        "receptions:kpis",
        `receptions:detail:${receipt.rows[0].reception_id}`,
        "receipt-processing",
        "receipt-processing-line",
      ],
    },
    { deduplicationKey: `receipt-processing:${recorded.rows[0].id}` },
  );
}

export async function readProcessingLine(
  tx: Queryable,
  lineId: string,
  receptionId?: string,
  lock = false,
): Promise<ProcessingLine> {
  const row = (
    await tx.query<
      Omit<
        ProcessingLine,
        | "packagings"
        | "stage"
        | "queues"
        | "blocking"
        | "accepted"
        | "controlId"
      >
    >(
      `
    SELECT l.id::text,l.reception_id::text AS "receptionId",r.reception_no AS "receptionNumber",r.status AS "receiptStatus",
      l.processing_policy AS policy,l.processing_version AS version,l.processing_reconciliation_required AS "reconciliationRequired",
      l.receipt_tool_id AS "toolId",l.stock_managed AS "stockManaged",l.receipt_quality_required AS "qualityRequired",
      COALESCE(d.disposed,0)::float8 AS disposed,COALESCE(d.open_nc,0)::integer AS "openNc",
      l.article_id::text AS "articleId",a.code AS "articleCode",COALESCE(l.designation,a.designation) AS designation,
      l.stock_article_id::text AS "stockArticleId",mp.code AS "stockArticleCode",COALESCE(f.nom,f.raison_sociale,'') AS "supplierName",c.code AS "orderCode",
      l.lot_id::text AS "lotId",lot.lot_code AS "lotCode",lot.lot_status AS "lotStatus",l.unite AS unit,l.stock_unit AS "stockUnit",
      COALESCE(l.stock_conversion_coef,1)::float8 AS coefficient,l.destination_magasin_id::text AS "destinationMagasinId",l.destination_emplacement_id AS "destinationEmplacementId",
      l.qty_received::float8 AS received,COALESCE((SELECT sum(quantity) FROM public.reception_packaging p WHERE p.receipt_line_id=l.id AND p.voided_at IS NULL),0)::float8 AS packed,
      (COALESCE((SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=l.id AND m.status='POSTED'),0)
       +COALESCE((SELECT sum(s.quantity) FROM public.reception_tool_stock_receipts s WHERE s.receipt_line_id=l.id),0))::float8 AS stocked
    FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
    LEFT JOIN public.receipt_processing_dispositions_1069 d ON d.receipt_line_id=l.id
    JOIN public.articles a ON a.id=l.article_id LEFT JOIN public.articles mp ON mp.id=l.stock_article_id
    LEFT JOIN public.fournisseurs f ON f.id=r.fournisseur_id LEFT JOIN public.lots lot ON lot.id=l.lot_id
    LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id LEFT JOIN public.commande_fournisseur c ON c.id=cl.commande_id
    WHERE l.id=$1::uuid AND ($2::uuid IS NULL OR l.reception_id=$2::uuid) ${lock ? "FOR UPDATE OF l,r" : ""}`,
      [lineId, receptionId ?? null],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "RECEIPT_LINE_NOT_FOUND",
      "Ligne de réception introuvable.",
    );
  let accepted = row.qualityRequired ? 0 : row.received;
  let controlId: string | null = null;
  const blocking: string[] = [];
  if (row.qualityRequired && !row.lotId)
    blocking.push("Identifiez le lot reçu avant son contrôle.");
  if (row.lotId && row.qualityRequired) {
    try {
      const quality = await readReceiptLotQualityEligibility({
        client: tx,
        lotId: row.lotId,
        receiptLineId: row.id,
        qty: row.received * row.coefficient,
        unit: row.stockUnit,
      });
      accepted = Math.min(
        row.received,
        quality.eligibility.qty_allowed / row.coefficient,
      );
      controlId = quality.evidence.control_ids[0] ?? null;
      blocking.push(
        ...quality.eligibility.blocks
          .filter((b) => b.code !== "QTY_NOT_RELEASED")
          .map((b) => b.message),
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      blocking.push(error.message);
    }
  }
  if (row.reconciliationRequired)
    blocking.push(
      "La reprise de cette réception doit être vérifiée et justifiée.",
    );
  const subcontract = await readReceiptSubcontract(tx, lineId);
  if (subcontract && !subcontract.linked)
    blocking.push(
      "Rattachez le retour aux lots expédiés du dossier de sous-traitance.",
    );
  if (row.receiptStatus === "CANCELLED") blocking.push("Réception annulée.");
  if (row.packed > accepted + 0.000001)
    blocking.push(
      "Une décision qualité a modifié la quantité autorisée. Rapprochez les portions emballées.",
    );
  if (row.disposed + accepted > row.received + 0.000001)
    blocking.push(
      "Les décisions qualité et les écarts soldés dépassent la quantité reçue. Rapprochez les décisions avant de poursuivre.",
    );
  const packagings = (
    await tx.query<ProcessingLine["packagings"][number]>(
      `SELECT p.id::text,p.quantity::float8,p.packaging,p.package_count AS "packageCount",p.created_at::text AS "createdAt",p.voided_at::text AS "voidedAt",
    COALESCE((SELECT sum(s.quantity) FROM public.reception_stock_portions s JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.packaging_id=p.id AND m.status='POSTED'),0)::float8 AS stocked
    FROM public.reception_packaging p WHERE p.receipt_line_id=$1::uuid ORDER BY p.created_at,p.id`,
      [lineId],
    )
  ).rows;
  const progress = receiptProcessingState(
    { ...row, accepted },
    blocking.length > 0,
  );
  if (row.policy === "STANDARD") {
    progress.queues.TO_PACK = 0;
    progress.queues.TO_STOCK =
      row.stockManaged || row.toolId ? Math.max(0, accepted - row.stocked) : 0;
    progress.stage = blocking.length
      ? "BLOCKED"
      : accepted >= row.received &&
          (!(row.stockManaged || row.toolId) || row.stocked >= row.received)
        ? "DONE"
        : progress.queues.TO_STOCK > 0
          ? "TO_STOCK"
          : "TO_CONTROL";
  }
  if (row.policy === "PIECES_CONTROLE_EMBALLAGE") {
    progress.queues.TO_CONTROL = Math.max(
      0,
      row.received - accepted - row.disposed,
    );
    if (
      !row.reconciliationRequired &&
      row.receiptStatus !== "CANCELLED" &&
      row.openNc === 0 &&
      Math.abs(row.stocked + row.disposed - row.received) < 0.000001
    )
      progress.stage = "DONE";
  }
  return {
    ...row,
    accepted,
    controlId,
    blocking,
    packagings,
    subcontract,
    ...progress,
  };
}

export async function getProcessingLine(receptionId: string, lineId: string) {
  const tx = await pool.connect();
  try {
    return await readProcessingLine(tx, lineId, receptionId);
  } finally {
    tx.release();
  }
}

export function receiptAllowedActions(
  line: ProcessingLine,
  canReceive: boolean,
): string[] {
  if (!canReceive || line.receiptStatus !== "OPEN") return [];
  const pieces = line.policy === "PIECES_CONTROLE_EMBALLAGE";
  const actions: string[] = [];
  if (line.subcontract && !line.subcontract.linked)
    actions.push("subcontract-origins");
  if (pieces) actions.push("stock-article");
  if (line.reconciliationRequired)
    return [
      ...actions,
      ...(line.stocked === 0 ? ["reconcile-processing"] : []),
    ];
  if (!line.blocking.length) {
    if (pieces && line.queues.TO_PACK > 0) actions.push("pack");
    if (line.queues.TO_STOCK > 0 && (!pieces || line.stockArticleId))
      actions.push(line.toolId ? "tool-stock" : "stock");
  }
  if (pieces && line.packagings.some((p) => !p.voidedAt && !p.stocked))
    actions.push("void-packaging");
  return actions;
}

export function assertProcessingWritable(
  line: ProcessingLine,
  expectedVersion: number,
  allowReconciliation = false,
) {
  if (line.policy !== "PIECES_CONTROLE_EMBALLAGE")
    throw new HttpError(
      409,
      "RECEIPT_PROCESSING_NOT_APPLICABLE",
      "Ce parcours est réservé aux pièces reçues et aux retours de sous-traitance.",
    );
  if (line.receiptStatus !== "OPEN")
    throw new HttpError(
      409,
      "RECEIPT_NOT_OPEN",
      "Cette réception est close ou annulée.",
    );
  if (line.version !== expectedVersion)
    throw new HttpError(
      409,
      "RECEIPT_PROCESSING_CHANGED",
      "Une étape a changé. Relisez les quantités avant de confirmer.",
    );
  if (line.reconciliationRequired && !allowReconciliation)
    throw new HttpError(
      409,
      "RECEIPT_RECONCILIATION_REQUIRED",
      "Vérifiez la reprise de cette réception avant de poursuivre.",
    );
  if (line.accepted + line.disposed > line.received + 0.000001)
    throw new HttpError(
      409,
      "RECEIPT_QUANTITY_INCONSISTENT",
      "Les quantités acceptées et les écarts soldés dépassent le reçu. Rapprochez les décisions avant de poursuivre.",
    );
}

export async function packReceipt(
  receptionId: string,
  lineId: string,
  body: PackReceiptBody,
  audit: AuditContext,
) {
  const commandBody = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "RECEIPT_PACK",
    commandBody,
    audit,
    async (tx) => {
      const line = await readProcessingLine(tx, lineId, receptionId, true);
      assertProcessingWritable(line, body.expectedVersion);
      await assertReceiptSubcontractLinked(tx, lineId);
      if (!line.lotId || !line.controlId)
        throw new HttpError(
          409,
          "RECEIPT_CONTROL_REQUIRED",
          "Terminez le contrôle qualité avant de valider l’emballage.",
        );
      assertPackingQuantity(line, body.quantity);
      await assertDeliveryNoteTx(tx, receptionId);
      const quality = await assertReceiptLotQualityEligibility({
        client: tx,
        lotId: line.lotId,
        receiptLineId: lineId,
        qty: (line.packed + body.quantity) * line.coefficient,
        unit: line.stockUnit,
      });
      const result = (
        await tx.query<{ id: string }>(
          `INSERT INTO public.reception_packaging(receipt_line_id,quantity,packaging,package_count,quality_control_id,quality_release_ids,notes,created_by)
      VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::jsonb,$7,$8) RETURNING id::text`,
          [
            lineId,
            body.quantity,
            body.packaging,
            body.packageCount,
            line.controlId,
            JSON.stringify(quality.evidence.release_decision_ids),
            body.notes ?? null,
            audit.user_id,
          ],
        )
      ).rows[0];
      await processingEvent(tx, lineId, audit, "PACKED", {
        packagingId: result.id,
        quantity: body.quantity,
        controlId: line.controlId,
      });
      return readProcessingLine(tx, lineId, receptionId);
    },
  );
}

export async function configureStockArticle(
  receptionId: string,
  lineId: string,
  body: {
    idempotencyKey: string;
    expectedVersion: number;
    stockArticleId: string;
  },
  audit: AuditContext,
) {
  const commandBody = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "RECEIPT_MP_MAPPING",
    commandBody,
    audit,
    async (tx) => {
      const line = await readProcessingLine(tx, lineId, receptionId, true);
      assertProcessingWritable(line, body.expectedVersion, true);
      const target = (
        await tx.query<{ unite: string }>(
          `SELECT unite FROM public.articles a WHERE a.id=$1::uuid AND a.article_category='matiere' AND a.stock_managed AND a.is_active
      AND NOT EXISTS(SELECT 1 FROM public.article_tool_links t WHERE t.article_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code='consommable') FOR SHARE`,
          [body.stockArticleId],
        )
      ).rows[0];
      if (
        !target ||
        target.unite?.trim().toUpperCase() !==
          line.stockUnit?.trim().toUpperCase()
      )
        throw new HttpError(
          422,
          "RECEIPT_MP_ARTICLE_REQUIRED",
          "Choisissez un article matière première actif, stocké, dans la même unité.",
        );
      if (line.stocked > 0 && line.stockArticleId !== body.stockArticleId)
        throw new HttpError(
          409,
          "RECEIPT_MP_MAPPING_ALREADY_USED",
          "Des pièces sont déjà stockées sous cette référence MP.",
        );
      await tx.query(
        `INSERT INTO public.article_receipt_mp_links(article_id,stock_article_id,updated_by) VALUES($1::uuid,$2::uuid,$3)
      ON CONFLICT(article_id) DO UPDATE SET stock_article_id=excluded.stock_article_id,updated_by=excluded.updated_by,updated_at=now()`,
        [line.articleId, body.stockArticleId, audit.user_id],
      );
      await tx.query(
        "UPDATE public.reception_fournisseur_lignes SET stock_article_id=$2::uuid WHERE id=$1::uuid",
        [lineId, body.stockArticleId],
      );
      await processingEvent(tx, lineId, audit, "MP_MAPPING", {
        before: line.stockArticleId,
        after: body.stockArticleId,
      });
      return readProcessingLine(tx, lineId, receptionId);
    },
  );
}

export async function reconcileProcessing(
  receptionId: string,
  lineId: string,
  body: { idempotencyKey: string; expectedVersion: number; reason: string },
  audit: AuditContext,
) {
  const commandBody = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "RECEIPT_RECONCILE",
    commandBody,
    audit,
    async (tx) => {
      const line = await readProcessingLine(tx, lineId, receptionId, true);
      assertProcessingWritable(line, body.expectedVersion, true);
      if (line.stocked > 0)
        throw new HttpError(
          409,
          "RECEIPT_HISTORICAL_STOCK_REVIEW_REQUIRED",
          "Cette réception porte déjà du stock historique. Conservez ses mouvements et traitez la correction de stock avant de reprendre ce parcours.",
        );
      await tx.query(
        "UPDATE public.reception_fournisseur_lignes SET processing_reconciliation_required=false WHERE id=$1::uuid",
        [lineId],
      );
      await processingEvent(tx, lineId, audit, "RECONCILED", {
        reason: body.reason,
      });
      return readProcessingLine(tx, lineId, receptionId);
    },
  );
}

export async function voidPackaging(
  receptionId: string,
  lineId: string,
  body: {
    idempotencyKey: string;
    expectedVersion: number;
    packagingId: string;
    reason: string;
  },
  audit: AuditContext,
) {
  const commandBody = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "RECEIPT_PACK_VOID",
    commandBody,
    audit,
    async (tx) => {
      const line = await readProcessingLine(tx, lineId, receptionId, true);
      assertProcessingWritable(line, body.expectedVersion);
      const pack = line.packagings.find(
        (p) => p.id === body.packagingId && !p.voidedAt,
      );
      if (!pack)
        throw new HttpError(
          404,
          "RECEIPT_PACKAGING_NOT_FOUND",
          "Emballage introuvable ou déjà annulé.",
        );
      if (pack.stocked > 0)
        throw new HttpError(
          409,
          "RECEIPT_PACKAGING_ALREADY_STOCKED",
          "Cet emballage a déjà alimenté le stock. Utilisez une correction de stock tracée.",
        );
      await tx.query(
        "UPDATE public.reception_packaging SET voided_at=now(),voided_by=$2,void_reason=$3 WHERE id=$1::uuid",
        [pack.id, audit.user_id, body.reason],
      );
      await processingEvent(tx, lineId, audit, "PACKING_VOIDED", {
        packagingId: pack.id,
        reason: body.reason,
      });
      return readProcessingLine(tx, lineId, receptionId);
    },
  );
}

export async function listProcessingLines(filters: ProcessingQuery) {
  let search = filters.q ?? "",
    entityFilter = "",
    entityId: string | null = null;
  if (/^CERP:/i.test(search)) {
    const label = await repoFindLabelByPublicId(
      parseIdentificationPayload(search),
    );
    if (!label || label.status !== "ACTIVE")
      throw new HttpError(
        404,
        "RECEIPT_SCAN_UNKNOWN",
        "Étiquette inconnue, remplacée ou invalidée.",
      );
    const predicates: Record<string, string> = {
      STOCK_ARTICLE: "r.article_id::text=$2 OR r.stock_article_id::text=$2",
      STOCK_LOT:
        "r.lot_id::text=$2 OR EXISTS(SELECT 1 FROM public.reception_stock_portions p WHERE p.receipt_line_id=r.id AND p.stock_lot_id::text=$2)",
      PURCHASE_ORDER: "cl.commande_id::text=$2",
      WORK_ORDER:
        "cl.of_id::text=$2 OR EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne_besoin b WHERE b.ligne_id=cl.id AND b.besoin_of_id::text=$2 AND NOT b.annule)",
    };
    if (!predicates[label.entity_type])
      throw new HttpError(
        422,
        "RECEIPT_SCAN_WRONG_TYPE",
        "Scannez une commande, un OF, un article ou un lot.",
      );
    entityFilter = `AND EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes r LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=r.commande_fournisseur_ligne_id WHERE r.id=v.id AND (${predicates[label.entity_type]}))`;
    entityId = label.entity_id;
    search = "";
  }
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const stagePredicate: Record<string, string> = {
      TO_CONTROL: "v.received > v.accepted+COALESCE(d.disposed,0)",
      TO_PACK: "v.policy='PIECES_CONTROLE_EMBALLAGE' AND v.accepted > v.packed",
      TO_STOCK:
        "CASE WHEN v.policy='PIECES_CONTROLE_EMBALLAGE' THEN v.packed ELSE v.accepted END > v.stocked AND (v.stock_managed OR v.receipt_tool_id IS NOT NULL)",
      DONE: "NOT v.reconciliation_required AND ((v.stocked+COALESCE(d.disposed,0) >= v.received AND COALESCE(d.open_nc,0)=0) OR (NOT v.stock_managed AND v.receipt_tool_id IS NULL AND v.accepted>=v.received))",
      BLOCKED: `v.reconciliation_required OR COALESCE(d.open_nc,0)>0 OR v.lot_status='BLOQUE' OR v.packed>v.accepted
        OR EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes r LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=r.commande_fournisseur_ligne_id WHERE r.id=v.id
          AND ((r.receipt_quality_required AND (r.lot_id IS NULL OR v.lot_status IN('EN_ATTENTE','QUARANTAINE') OR NOT EXISTS(SELECT 1 FROM public.quality_control q WHERE q.lot_id=r.lot_id AND q.reception_ligne_id=r.id AND q.trigger_type='RECEPTION')))
            OR (cl.type='SOUS_TRAITANCE' AND NOT EXISTS(SELECT 1 FROM public.reception_subcontract_origins b WHERE b.receipt_line_id=r.id))))`,
    };
    const where = `v.receipt_status<>'CANCELLED' AND ($1='' OR concat_ws(' ',v.reception_number,v.article_code,v.designation,v.supplier_name,v.order_code,v.lot_code) ILIKE $1) AND ($2::text IS NULL OR true) ${entityFilter}
      ${filters.stage ? `AND (${stagePredicate[filters.stage]})` : ""}`;
    const params = [search ? `%${search}%` : "", entityId];
    const total = Number(
      (
        await tx.query<{ count: string }>(
          `SELECT count(*) FROM public.receipt_processing_queue_1069 v LEFT JOIN public.receipt_processing_dispositions_1069 d ON d.receipt_line_id=v.id WHERE ${where}`,
          params,
        )
      ).rows[0].count,
    );
    const ids = (
      await tx.query<{ id: string }>(
        `SELECT v.id::text FROM public.receipt_processing_queue_1069 v LEFT JOIN public.receipt_processing_dispositions_1069 d ON d.receipt_line_id=v.id WHERE ${where} ORDER BY v.reception_date,v.id LIMIT $3 OFFSET $4`,
        [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
      )
    ).rows;
    const items: ProcessingLine[] = [];
    for (const row of ids) items.push(await readProcessingLine(tx, row.id));
    await tx.query("COMMIT");
    return { items, total, page: filters.page, pageSize: filters.pageSize };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
