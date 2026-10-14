import { HttpError } from "../../../utils/httpError";
import { formatDecimal,moneyToCents,parseDecimal } from "./decimal-money";
import type { FacturePreviewLine } from "../types/workflow.types";
import type { FinalPrepaymentTarget } from "./final-invoice-prepayments";

/** Largest remainders preserve every cent; ties use stable business source IDs. */
export function apportionExactCents(total:bigint,weights:readonly {key:string;weight:bigint}[]):Map<string,bigint>{
  if(total<0n || weights.some(item=>item.weight<0n) || new Set(weights.map(item=>item.key)).size!==weights.length)
    throw new HttpError(409,"PROFORMA_PREPAYMENT_TARGET_INVALID","La répartition des montants doit être vérifiée.");
  const sum=weights.reduce((n,item)=>n+item.weight,0n);
  if(sum===0n){if(total!==0n)throw new HttpError(409,"PROFORMA_PREPAYMENT_TARGET_INVALID","Les montants sources de la facture sont absents.");return new Map(weights.map(item=>[item.key,0n]));}
  const parts=weights.map(item=>({key:item.key,cents:total*item.weight/sum,remainder:total*item.weight%sum}));
  let left=total-parts.reduce((n,item)=>n+item.cents,0n);
  const ranked=[...parts].sort((a,b)=>a.remainder===b.remainder?(a.key<b.key?-1:a.key>b.key?1:0):a.remainder>b.remainder?-1:1);
  for(const item of ranked){if(left===0n)break;item.cents++;left--;}
  return new Map(parts.map(item=>[item.key,item.cents]));
}

/** Allocate the actual document gross, including its global discount, once. */
export function finalPrepaymentTargets(lines:readonly FacturePreviewLine[],gross:string):FinalPrepaymentTarget[]{
  const allocated=apportionExactCents(moneyToCents(gross),lines.map(line=>({key:line.source_line_id,weight:moneyToCents(line.total_incl_tax)})));
  const targets:FinalPrepaymentTarget[]=[];
  for(const line of lines){
    if(!line.proforma_contributions?.length)continue;
    const weights=line.proforma_contributions.map(part=>({key:part.billing_part_id,weight:parseDecimal(part.quantity,3,"Quantité de l'affaire")}));
    if(weights.reduce((n,item)=>n+item.weight,0n)!==parseDecimal(line.quantity,3,"Quantité facturée"))
      throw new HttpError(409,"PROFORMA_PREPAYMENT_TARGET_INVALID","Les quantités attribuées doivent correspondre à la ligne facturée.");
    const parts=apportionExactCents(allocated.get(line.source_line_id)!,weights);
    for(const contribution of line.proforma_contributions)targets.push({source_line_id:line.source_line_id,billing_part_id:contribution.billing_part_id,
      amount_incl_tax:formatDecimal(parts.get(contribution.billing_part_id)!,2)});
  }
  return targets;
}
