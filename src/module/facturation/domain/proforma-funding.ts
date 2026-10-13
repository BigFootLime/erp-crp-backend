import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents } from "./decimal-money";

/** Evidence comes from allocated receipts on real issued deposit invoices. */
export type ProformaReceiptEvidence = {
  id: string;
  paymentAllocationId: string;
  billedClientId: string;
  currency: string;
  amount: string;
  releasedAmount: string;
  paymentStatus: string;
  paymentWorkflowStatus: string;
  reversalOfId: number | null;
  depositDocumentStatus: string;
};

export type ProformaFundingResult = {
  requiredAmount: string;
  paidAmount: string;
  remainingAmount: string;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "INVALID";
  blockers: Array<{ code: string; message: string }>;
};

/**
 * Transferring an advance to the final invoice does not undo its receipt.
 * Only an explicit release or a reversed/rejected payment removes coverage.
 * SQL locks/caps the parent payment allocation before evidence is inserted.
 */
export function proformaLineFunding(args: {
  billedClientId: string;
  currency: string;
  requiredAmount: string;
  issuedCreditsAmount: string;
  receipts: readonly ProformaReceiptEvidence[];
}): ProformaFundingResult {
  const required = moneyToCents(args.requiredAmount, "Montant à payer");
  const credited = moneyToCents(args.issuedCreditsAmount, "Acomptes crédités");
  if (required < 0n) throw new HttpError(422, "PROFORMA_AMOUNT_INVALID", "Le montant à payer ne peut pas être négatif.");
  if (credited < 0n) throw new HttpError(422, "PROFORMA_CREDIT_INVALID", "Le montant crédité ne peut pas être négatif.");
  const blockers: ProformaFundingResult["blockers"] = [];
  const seen = new Set<string>();
  let paid = 0n;
  for (const receipt of args.receipts) {
    if (seen.has(receipt.id)) {
      throw new HttpError(409, "PROFORMA_RECEIPT_DUPLICATED", "Une affectation de règlement apparaît plusieurs fois.");
    }
    seen.add(receipt.id);
    const amount = moneyToCents(receipt.amount, "Règlement affecté");
    const released = moneyToCents(receipt.releasedAmount, "Règlement libéré");
    if (amount <= 0n || released < 0n || released > amount) {
      blockers.push({ code: "PROFORMA_RECEIPT_AMOUNT_INVALID", message: "L'affectation du règlement doit être vérifiée." });
      continue;
    }
    if (receipt.billedClientId !== args.billedClientId || receipt.currency !== args.currency) {
      blockers.push({ code: "PROFORMA_RECEIPT_PARTY_MISMATCH", message: "Le règlement doit correspondre à la société facturée et à la devise." });
      continue;
    }
    if (receipt.paymentStatus === "REVERSED" || receipt.paymentStatus === "REJECTED"
      || receipt.paymentWorkflowStatus === "REVERSED" || receipt.reversalOfId !== null) continue;
    if (!["UNALLOCATED", "PARTIALLY_ALLOCATED", "ALLOCATED"].includes(receipt.paymentStatus)
      || !["RECORDED", "ALLOCATED"].includes(receipt.paymentWorkflowStatus)) {
      blockers.push({ code: "PROFORMA_RECEIPT_STATUS_UNKNOWN", message: "L'état du règlement doit être vérifié." });
      continue;
    }
    if (receipt.depositDocumentStatus !== "ISSUED") continue;
    paid += amount - released;
  }
  // A credit note is a fiscal correction, never proof of cash for these goods.
  // Read its sum once per billed part, not once per partial receipt.
  paid = paid > credited ? paid - credited : 0n;
  if (credited > required) blockers.push({ code: "PROFORMA_CREDIT_EXCEEDED", message: "Les avoirs d'acompte doivent être vérifiés." });
  if (paid > required) blockers.push({ code: "PROFORMA_RECEIPTS_EXCEEDED", message: "Les affectations dépassent le montant de cette ligne." });
  return {
    requiredAmount: formatDecimal(required, 2),
    paidAmount: formatDecimal(paid, 2),
    remainingAmount: formatDecimal(paid >= required ? 0n : required - paid, 2),
    status: blockers.length ? "INVALID" : paid >= required ? "PAID" : paid > 0n ? "PARTIALLY_PAID" : "UNPAID",
    blockers,
  };
}

/** One parent receipt can fund several affairs, within its already allocated amount. */
export function assertProformaReceiptBudget(args: {
  allocatedAmount: string;
  usedAmount: string;
  requestedAmount: string;
}): void {
  const allocated = moneyToCents(args.allocatedAmount, "Règlement disponible");
  const used = moneyToCents(args.usedAmount, "Règlement déjà affecté");
  const requested = moneyToCents(args.requestedAmount, "Règlement à affecter");
  if (allocated < 0n || used < 0n || used > allocated || requested <= 0n) {
    throw new HttpError(409, "PROFORMA_RECEIPT_BUDGET_INVALID", "La disponibilité de ce règlement doit être vérifiée.");
  }
  if (requested > allocated - used) {
    throw new HttpError(409, "PROFORMA_RECEIPT_BUDGET_EXCEEDED", "Ce règlement est déjà affecté à d'autres affaires.");
  }
}
