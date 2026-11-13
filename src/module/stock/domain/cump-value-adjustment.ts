import { parseCumpDecimal as decimal,formatCumpDecimal as text } from './cump-decimal';
import { normalizeCumpScope,CUMP_FORMULA_VERSION,type CumpState,type CumpTransitionResult } from './cump-valuation';

export const CUMP_VALUE_ADJUSTMENT_FORMULA='CERP-CUMP-VALUE-ADJUSTMENT-1.0.0' as const;

/** The documented amount justifies the whole current company scope. It is not
 * an invoice-to-remaining-stock allocation or a rewrite of any earlier cost. */
export function applyCumpValueAdjustment(input:CumpState,totalValue:string,entryRef:string):CumpTransitionResult {
  const scope=normalizeCumpScope(input.scope);
  if(scope.owner!=='COMPANY'||scope.currency!=='EUR')throw new Error('CUMP_ADJUSTMENT_COMPANY_EUR_REQUIRED');
  const quantity=decimal(input.quantity),afterValue=decimal(totalValue);
  if(quantity<=0n||!entryRef.trim()||!input.sourceRef?.trim())throw new Error('CUMP_ADJUSTMENT_BALANCE_REQUIRED');
  if(!['VERIFIED','DECLARED','UNKNOWN'].includes(input.reliability) ||
    (input.value===null)!==(input.reliability==='UNKNOWN'))throw new Error('CUMP_ADJUSTMENT_PREVIOUS_VALUE_INVALID');
  const beforeValue=input.value===null?null:decimal(input.value);
  const delta=beforeValue===null?null:afterValue-beforeValue;
  const before:CumpState={...input,scope,quantity:text(quantity),value:beforeValue===null?null:text(beforeValue)};
  const after:CumpState={scope,quantity:text(quantity),value:text(afterValue),reliability:'DECLARED',sourceRef:entryRef};
  return {formulaVersion:CUMP_FORMULA_VERSION,before,after,quantityDelta:'0',
    valueDelta:delta===null?null:text(delta),movementValue:delta===null?null:text(delta<0n?-delta:delta),
    unitCost:null,movementReliability:'DECLARED',issues:beforeValue===null?['PREVIOUS_VALUE_UNKNOWN']:[]};
}
