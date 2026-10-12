/** Physical receipt remainder which has not been accepted into stock. */
export type ReceiptDispositionContext = {
  receiptLineId: string;
  unit: string;
  remainingQty: number;
  reconciliationRequired: boolean;
};
