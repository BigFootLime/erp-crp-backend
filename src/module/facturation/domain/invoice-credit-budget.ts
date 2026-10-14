import { HttpError } from "../../../utils/httpError";
import { divideHalfUp,formatDecimal,moneyToCents,parseDecimal } from "./decimal-money";
import { documentTaxBreakdownFromSnapshot } from "./document-tax-breakdown";
import { apportionExactCents } from "./final-prepayment-targets";

export type OriginalCreditLine = {
  id:string; quantity:string; net:string; tax:string; gross:string; rate:string; discount:string;
  creditedQuantity:string; creditedNet:string; creditedTax:string; creditedGross:string;
};
export type OriginalCreditBudget = {net:bigint;tax:bigint;gross:bigint};
function invalid():never {
  throw new HttpError(409,"AVOIR_ORIGINAL_BUDGET_INVALID","Les montants de la facture et des avoirs précédents doivent être vérifiés avant de préparer cet avoir.");
}

/** Retain the original document's discounted VAT categories, then distribute
 * their exact cents over its lines. No current price or tax rule is consulted. */
export function originalInvoiceCreditBudgets(args:{snapshot:unknown;lines:readonly OriginalCreditLine[];net:string;tax:string;gross:string}):Map<string,OriginalCreditBudget>{
  if(new Set(args.lines.map(line=>line.id)).size!==args.lines.length)invalid();
  const model=documentTaxBreakdownFromSnapshot({snapshot:args.snapshot,lines:args.lines.map(line=>({ratePercent:line.rate,net:line.net,tax:line.tax})),
    totalExTax:args.net,totalTax:args.tax,totalInclTax:args.gross});
  const result=new Map<string,OriginalCreditBudget>();
  for(const group of model.entries){
    const lines=args.lines.filter(line=>formatDecimal(parseDecimal(line.rate,4,"Taux de TVA"),4)===group.rate_percent);
    const bases=apportionExactCents(moneyToCents(group.taxable_amount),lines.map(line=>({key:line.id,weight:moneyToCents(line.net)})));
    const taxWeights=lines.map(line=>({key:line.id,weight:moneyToCents(line.tax)}));
    const taxes=apportionExactCents(moneyToCents(group.tax_amount),taxWeights.some(item=>item.weight>0n)?taxWeights:lines.map(line=>({key:line.id,weight:bases.get(line.id)!})));
    for(const line of lines){const net=bases.get(line.id)!,tax=taxes.get(line.id)!;
      if(moneyToCents(line.net)+moneyToCents(line.tax)!==moneyToCents(line.gross)||parseDecimal(line.quantity,3,"Quantité facturée")<=0n)invalid();
      result.set(line.id,{net,tax,gross:net+tax});
    }
  }
  return result;
}

/** Cumulative fractions carry the last cent across successive partial credits.
 * Existing fiscal evidence is subtracted, never silently rewritten. */
export function originalInvoiceLineCredit(line:OriginalCreditLine,budget:OriginalCreditBudget,selected:string){
  const quantity=parseDecimal(line.quantity,3,"Quantité facturée"),credited=parseDecimal(line.creditedQuantity,3,"Quantité déjà créditée"),pick=parseDecimal(selected,3,"Quantité créditée");
  if(quantity<=0n||credited<0n||credited>quantity||pick<=0n||pick>quantity-credited)
    throw new HttpError(409,"AVOIR_QUANTITY_EXCEEDS_REMAINING","La quantité d'avoir dépasse la quantité encore créditable.");
  const priorNet=moneyToCents(line.creditedNet),priorTax=moneyToCents(line.creditedTax),priorGross=moneyToCents(line.creditedGross);
  if(priorNet<0n||priorTax<0n||priorNet+priorTax!==priorGross||priorNet>budget.net||priorTax>budget.tax||priorGross>budget.gross)invalid();
  const after=credited+pick,net=divideHalfUp(budget.net*after,quantity)-priorNet,tax=divideHalfUp(budget.tax*after,quantity)-priorTax;
  if(net<0n||tax<0n)invalid();
  return{net:formatDecimal(net,2),tax:formatDecimal(tax,2),gross:formatDecimal(net+tax,2)};
}

/** Include the original document allowance in the credit's line price once.
 * Preserve its separate provenance; do not discount the credit again. */
export function originalCreditEffectiveDiscount(lineDiscount:string,documentDiscount:string):string{
  const line=parseDecimal(lineDiscount,4,"Remise de ligne"),document=parseDecimal(documentDiscount,4,"Remise de la facture");
  const hundred=1_000_000n;if(line<0n||line>hundred||document<0n||document>hundred)invalid();
  return formatDecimal(hundred-divideHalfUp((hundred-line)*(hundred-document),hundred),4);
}
