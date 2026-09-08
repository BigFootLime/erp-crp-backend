import {materialPropertiesFingerprint as fingerprint,type DebitRule,type MaterialRequirements} from './of-material';

export type ReconciliationIdentity={articleId:string|null;unit:string|null;supplyMode:string;requirements:MaterialRequirements;debitRule:DebitRule|null;operationId:string|null;consumed:number};
/** Promises keep their purchased specification. Incompatible requirements
 * stay explicit, outside the new coverage, until the buyer/methods treats them. */
export function materialCarryBlockers(previous:ReconciliationIdentity,target:ReconciliationIdentity):string[]{
  const blockers:string[]=[];
  if(!previous.articleId||previous.articleId!==target.articleId)blockers.push('L’article matière a changé.');
  if(!previous.unit||previous.unit!==target.unit)blockers.push('L’unité de stock a changé.');
  if(previous.supplyMode!==target.supplyMode)blockers.push('L’origine achat ou client a changé.');
  if(fingerprint(previous.requirements)!==fingerprint(target.requirements))blockers.push('Les exigences matière diffèrent ; faites traiter les engagements existants par les méthodes et les achats.');
  if(previous.consumed>0&&(previous.operationId!==target.operationId||fingerprint(previous.debitRule)!==fingerprint(target.debitRule)))
    blockers.push('Un débit existe : son opération et sa règle de conversion doivent rester identiques.');
  return blockers;
}
