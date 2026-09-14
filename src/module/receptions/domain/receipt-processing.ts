import { HttpError } from "../../../utils/httpError";

export const RECEIPT_PROCESSING_POLICIES = [
  "STANDARD",
  "PIECES_CONTROLE_EMBALLAGE",
] as const;
export type ReceiptProcessingPolicy =
  (typeof RECEIPT_PROCESSING_POLICIES)[number];
export type ReceiptProcessingStage =
  "TO_CONTROL" | "TO_PACK" | "TO_STOCK" | "DONE" | "BLOCKED";
export type ReceiptQuantities = {
  received: number;
  accepted: number;
  packed: number;
  stocked: number;
};
const EPSILON = 0.000001;

export function processingPolicy(input: {
  categories: readonly string[];
  category?: string | null;
  orderType?: string | null;
  toolId?: number | null;
  mappedPiece?: boolean;
}): ReceiptProcessingPolicy {
  if (input.toolId || input.categories.includes("consommable"))
    return "STANDARD";
  return input.mappedPiece ||
    input.orderType === "SOUS_TRAITANCE" ||
    input.category === "fabrique" ||
    input.category === "achat" ||
    input.categories.some((c) =>
      ["piece_finie_fabriquee", "sous_traitance", "achat_revente"].includes(c),
    )
    ? "PIECES_CONTROLE_EMBALLAGE"
    : "STANDARD";
}

export function assertReceiptQuantities(q: ReceiptQuantities) {
  if (
    [q.received, q.accepted, q.packed, q.stocked].some(
      (v) => !Number.isFinite(v) || v < 0,
    )
  )
    throw new HttpError(
      422,
      "RECEIPT_QUANTITY_INVALID",
      "Les quantités de réception doivent être positives ou nulles.",
    );
  if (
    q.accepted > q.received + EPSILON ||
    q.packed > q.accepted + EPSILON ||
    q.stocked > q.packed + EPSILON
  )
    throw new HttpError(
      409,
      "RECEIPT_QUANTITY_INCONSISTENT",
      "Le stock ne peut pas dépasser l’emballage, ni l’emballage la quantité acceptée.",
      q,
    );
}

export function assertPackingQuantity(q: ReceiptQuantities, quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new HttpError(
      422,
      "RECEIPT_PACK_QUANTITY_REQUIRED",
      "Saisissez une quantité à emballer strictement positive.",
    );
  assertReceiptQuantities({ ...q, packed: q.packed + quantity });
}

export function assertStockingQuantity(q: ReceiptQuantities, quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new HttpError(
      422,
      "RECEIPT_STOCK_QUANTITY_REQUIRED",
      "Saisissez une quantité à mettre en stock strictement positive.",
    );
  if (quantity > q.packed - q.stocked + EPSILON)
    throw new HttpError(
      409,
      "RECEIPT_PACKAGING_REQUIRED",
      "Terminez et validez l’emballage de cette quantité avant son entrée en stock.",
      { maximum: Math.max(0, q.packed - q.stocked) },
    );
  assertReceiptQuantities({ ...q, stocked: q.stocked + quantity });
}

/** A line can contribute quantities to several queues simultaneously. */
export function receiptProcessingState(q: ReceiptQuantities, blocked: boolean) {
  const queues = {
    TO_CONTROL: Math.max(0, q.received - q.accepted),
    TO_PACK: Math.max(0, q.accepted - q.packed),
    TO_STOCK: Math.max(0, q.packed - q.stocked),
  };
  const stage: ReceiptProcessingStage = blocked
    ? "BLOCKED"
    : q.stocked >= q.received - EPSILON
      ? "DONE"
      : queues.TO_STOCK > EPSILON
        ? "TO_STOCK"
        : queues.TO_PACK > EPSILON
          ? "TO_PACK"
          : "TO_CONTROL";
  return { stage, queues };
}
