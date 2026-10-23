import { HttpError } from "../../../utils/httpError";

/** Generic movements must not manufacture receipts without a source workflow. */
export function assertStockEntrySource(input: {
  movementType: string;
  trustedSource?: boolean;
  reversalOfId?: string | null;
}): void {
  if (input.movementType === "IN" && !input.trustedSource && !input.reversalOfId) {
    throw new HttpError(422, "STOCK_ENTRY_SOURCE_REQUIRED",
      "Pour reprendre un stock existant, utilisez Base OLD. Les nouvelles entrées passent par une réception fournisseur ou une déclaration de fabrication.");
  }
}
