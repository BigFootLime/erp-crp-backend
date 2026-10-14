import { HttpError } from "../../../utils/httpError";
import { divideHalfUp, formatDecimal, moneyToCents } from "./decimal-money";

export type FinalPrepaymentTarget = {
  source_line_id: string;
  billing_part_id: string;
  amount_incl_tax: string;
};

/** Net cash and prior applications are selected by the server in one snapshot. */
export type FinalPrepaymentReceipt = {
  assignment_id: string;
  deposit_source_id: string;
  billing_part_id: string;
  billed_client_id: string;
  currency: string;
  deposit_invoice_id: number;
  deposit_invoice_number: string;
  deposit_invoice_date: string;
  available_amount: string;
  deposit_total_ex_tax: string;
  deposit_total_tax: string;
  deposit_total_incl_tax: string;
  deposit_available_incl_tax: string;
  deposit_already_applied_incl_tax: string;
  deposit_already_applied_ex_tax: string;
};

export type FinalPrepaymentApplication = {
  source_line_id: string;
  billing_part_id: string;
  assignment_id: string;
  deposit_source_id: string;
  deposit_invoice_id: number;
  deposit_invoice_number: string;
  deposit_invoice_date: string;
  amount_ex_tax: string;
  tax_amount: string;
  amount_incl_tax: string;
};

export type FinalPrepaymentPlan = {
  version: 1;
  amount_paid: string;
  amount_due: string;
  applications: FinalPrepaymentApplication[];
};

/** E-invoicing consumes frozen issuance facts, never subsequent bank changes. */
export function invoicePrepaymentAmountsFromSnapshot(snapshot:unknown,gross:string):{amountPaid:string;amountDue:string}|undefined{
  if(!snapshot || typeof snapshot!=="object" || Array.isArray(snapshot))return undefined;
  const value=(snapshot as Record<string,unknown>).prepayments;
  if(value===undefined)return undefined;
  if(!value || typeof value!=="object" || Array.isArray(value))throw new HttpError(409,"INVOICE_PREPAYMENT_SNAPSHOT_INVALID","Les acomptes figés de cette facture doivent être vérifiés.");
  const data=value as Record<string,unknown>;
  if(data.version!==1 || typeof data.amount_paid!=="string" || typeof data.amount_due!=="string")
    throw new HttpError(409,"INVOICE_PREPAYMENT_SNAPSHOT_INVALID","Les acomptes figés de cette facture doivent être vérifiés.");
  const paid=moneyToCents(data.amount_paid),due=moneyToCents(data.amount_due);
  if(paid<0n || due<0n || paid+due!==moneyToCents(gross))
    throw new HttpError(409,"INVOICE_PREPAYMENT_SNAPSHOT_INVALID","Le net à payer figé ne correspond pas au total et aux acomptes.");
  return{amountPaid:formatDecimal(paid,2),amountDue:formatDecimal(due,2)};
}

/** Apply actual unused cash once; prices, VAT and physical quantities stay intact. */
export function planFinalInvoicePrepayments(args: {
  billedClientId: string;
  currency: string;
  invoiceTotalInclTax: string;
  targets: readonly FinalPrepaymentTarget[];
  receipts: readonly FinalPrepaymentReceipt[];
}): FinalPrepaymentPlan {
  const fail = (): never => { throw new HttpError(409, "PROFORMA_PREPAYMENT_EVIDENCE_INVALID", "La ventilation des acomptes doit être vérifiée avant facturation."); };
  const gross = moneyToCents(args.invoiceTotalInclTax, "Total facture");
  if (gross < 0n) fail();
  const targetKeys = new Set<string>();
  const compareIds=(a:string,b:string):number=>a<b?-1:a>b?1:0;
  const targets = [...args.targets].sort((a,b)=>compareIds(`${a.source_line_id}:${a.billing_part_id}`,`${b.source_line_id}:${b.billing_part_id}`));
  for (const target of targets) {
    const key = `${target.source_line_id}:${target.billing_part_id}`;
    if (targetKeys.has(key) || moneyToCents(target.amount_incl_tax) < 0n) fail();
    targetKeys.add(key);
  }
  if(targets.reduce((sum,target)=>sum+moneyToCents(target.amount_incl_tax),0n)>gross)fail();
  const assignmentIds = new Set<string>();
  const receiptBudget = new Map<string,bigint>();
  const depositBudget = new Map<string,{originalGross:bigint;originalNet:bigint;remaining:bigint;usedGross:bigint;usedNet:bigint}>();
  const depositPart=new Map<string,string>(),depositCash=new Map<string,bigint>();
  const receipts = [...args.receipts].sort((a,b)=>compareIds(a.deposit_invoice_date,b.deposit_invoice_date)
    || a.deposit_invoice_id-b.deposit_invoice_id || compareIds(a.assignment_id,b.assignment_id));
  for (const receipt of receipts) {
    if (assignmentIds.has(receipt.assignment_id) || receipt.billed_client_id !== args.billedClientId || receipt.currency !== args.currency
      || !Number.isSafeInteger(receipt.deposit_invoice_id) || receipt.deposit_invoice_id<=0 || !receipt.deposit_invoice_number?.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.deposit_invoice_date)) fail();
    assignmentIds.add(receipt.assignment_id);
    const available = moneyToCents(receipt.available_amount), originalNet = moneyToCents(receipt.deposit_total_ex_tax),
      originalGross = moneyToCents(receipt.deposit_total_incl_tax), originalTax = moneyToCents(receipt.deposit_total_tax),
      remaining = moneyToCents(receipt.deposit_available_incl_tax), usedGross = moneyToCents(receipt.deposit_already_applied_incl_tax),
      usedNet = moneyToCents(receipt.deposit_already_applied_ex_tax);
    if (available<0n || originalGross<=0n || originalNet<0n || originalTax<0n || originalNet+originalTax!==originalGross
      || remaining<0n || usedGross<0n || usedGross>originalGross || usedNet<0n || usedNet>originalNet || usedNet>usedGross
      || remaining>originalGross-usedGross || available>originalGross-usedGross) fail();
    receiptBudget.set(receipt.assignment_id,available);
    const existing=depositBudget.get(receipt.deposit_source_id);
    const budget={originalGross,originalNet,remaining,usedGross,usedNet};
    if(existing && Object.keys(budget).some(key=>existing[key as keyof typeof budget]!==budget[key as keyof typeof budget]))fail();
    if(depositPart.has(receipt.deposit_source_id) && depositPart.get(receipt.deposit_source_id)!==receipt.billing_part_id)fail();
    const assignedCash=(depositCash.get(receipt.deposit_source_id)??0n)+available;
    if(assignedCash>originalGross-usedGross)fail();
    depositCash.set(receipt.deposit_source_id,assignedCash);depositPart.set(receipt.deposit_source_id,receipt.billing_part_id);
    depositBudget.set(receipt.deposit_source_id,budget);
  }
  let invoiceRemaining=gross;
  const applications:FinalPrepaymentApplication[]=[];
  for (const target of targets) {
    let targetRemaining=moneyToCents(target.amount_incl_tax);
    for (const receipt of receipts) {
      if (receipt.billing_part_id!==target.billing_part_id || targetRemaining===0n || invoiceRemaining===0n) continue;
      const deposit=depositBudget.get(receipt.deposit_source_id)!;
      const available=receiptBudget.get(receipt.assignment_id)!;
      const taken=[targetRemaining,invoiceRemaining,available,deposit.remaining].reduce((a,b)=>a<b?a:b);
      if(taken<=0n)continue;
      // Cumulative cents retain the last VAT/net cent across partial invoices.
      const cumulativeNet=divideHalfUp((deposit.usedGross+taken)*deposit.originalNet,deposit.originalGross);
      const net=cumulativeNet-deposit.usedNet, tax=taken-net;
      if(net<0n || tax<0n || cumulativeNet>deposit.originalNet)fail();
      applications.push({source_line_id:target.source_line_id,billing_part_id:target.billing_part_id,assignment_id:receipt.assignment_id,
        deposit_source_id:receipt.deposit_source_id,deposit_invoice_id:receipt.deposit_invoice_id,
        deposit_invoice_number:receipt.deposit_invoice_number,deposit_invoice_date:receipt.deposit_invoice_date,
        amount_ex_tax:formatDecimal(net,2),tax_amount:formatDecimal(tax,2),amount_incl_tax:formatDecimal(taken,2)});
      deposit.usedGross+=taken;deposit.usedNet+=net;deposit.remaining-=taken;
      receiptBudget.set(receipt.assignment_id,available-taken);targetRemaining-=taken;invoiceRemaining-=taken;
    }
  }
  return {version:1,amount_paid:formatDecimal(gross-invoiceRemaining,2),amount_due:formatDecimal(invoiceRemaining,2),applications};
}
