import {HttpError} from '../../../utils/httpError';
import {debitQuantity,quantity,type DebitRule} from './of-material';

export function actualDebitBalance(input:{rule:DebitRule;blanks:number;sources:Array<{id:string;quantity:number;remnant:number}>;varianceReason?:string|null}){
  const expected=debitQuantity(input.rule,input.blanks);
  if(!input.sources.length||input.sources.some(s=>![s.quantity,s.remnant].every(n=>Number.isFinite(n)&&n>=0)||s.quantity<=0||s.remnant>=s.quantity))
    throw new HttpError(422,'MATERIAL_DEBIT_BALANCE_INVALID','Chaque prélèvement doit être positif et sa chute inférieure à la quantité prélevée.');
  const actual=quantity(input.sources.reduce((sum,s)=>sum+s.quantity,0));
  const remnants=quantity(input.sources.reduce((sum,s)=>sum+s.remnant,0));
  if(input.rule.form==='UNIT'&&(actual!==expected||remnants>0))throw new HttpError(422,'MATERIAL_DEBIT_CONVERSION_MISMATCH','Les bruts unitaires doivent respecter exactement la quantité de la règle de débit.');
  if(input.rule.form==='SHEET'&&!input.rule.yieldValidated)throw new HttpError(409,'MATERIAL_SHEET_YIELD_REQUIRED','Les méthodes doivent valider le rendement de tôle.');
  if((actual!==expected||remnants>0)&&(input.varianceReason?.trim().length??0)<10)
    throw new HttpError(422,'MATERIAL_DEBIT_VARIANCE_REASON_REQUIRED','Expliquez les quantités réelles et les chutes par rapport à la règle prévue (10 caractères minimum).');
  let remaining=expected;
  const sources=input.sources.map((s,i)=>{const planned=i===input.sources.length-1?remaining:Math.min(remaining,quantity(expected*s.quantity/actual));remaining=quantity(remaining-planned);return {...s,planned};});
  return {expected,actual,remnants,net:quantity(actual-remnants),sources};
}
