import { HttpError } from "../../../utils/httpError";

/** Credits correct the invoice value, irrespective of whether cash was already received. */
export function customerInvoiceBalance(args: { gross: bigint; cash: bigint; credits: bigint; refunds: bigint }) {
  const { gross, cash, credits, refunds } = args;
  if (gross < 0n || cash < 0n || credits < 0n || credits > gross || refunds < 0n
    || refunds > cash || refunds > credits || cash - refunds > gross
    || refunds > (cash + credits > gross ? cash + credits - gross : 0n)) {
    throw new HttpError(409, "INVOICE_CUSTOMER_BALANCE_INVALID", "Les paiements, avoirs et remboursements doivent être rapprochés de cette facture.");
  }
  const settled = cash + credits - refunds;
  const due = settled < gross ? gross - settled : 0n;
  const refundable = settled > gross ? settled - gross : 0n;
  return { settled, due, refundable, creditsRemaining: gross - credits, netCash: cash - refunds };
}
