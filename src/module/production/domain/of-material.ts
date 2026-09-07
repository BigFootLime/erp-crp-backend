import {createHash} from "node:crypto";

// Stock registries store quantities to three decimal places. Work in integer
// thousandths for coverage so repeated partial receipts cannot leave a ghost need.
const milli=(value:number)=>Math.round(value*1000);
export const quantity=(value:number)=>milli(value)/1000;
export type MaterialRequirements={
  grade:string|null; condition:string|null; ownerClientId:string|null;
  dimensions:Record<string,number>; certificates:string[]; manualChecks:string[];
};
export type MaterialLot={
  id:string; batchId:string; articleId:string; code:string; unit:string|null; quality:string;
  available:number; receivedAt:string; grade:string|null; condition:string|null;
  ownerClientId:string|null; dimensions:Record<string,number>; certificates:string[];
  manualVerified:boolean;
  stockLevelId?:string;levelAvailable?:number;
  qualityAvailable?:number;qualityBlocks?:string[];
};
export type MaterialNeed={
  key:string; articleId:string|null; unit:string|null; required:number; requirements:MaterialRequirements;
  reserved:number; consumed:number; expected:number; receivedBlocked:number;
};
const normalized=(value:string|null)=>value?.trim().normalize("NFKC").toLocaleUpperCase("fr-FR")??null;
export function lotCompatibility(need:MaterialNeed,lot:MaterialLot):string[]{
  const reasons:string[]=[];
  reasons.push(...(lot.qualityBlocks??[]));
  if(!need.articleId||lot.articleId!==need.articleId)reasons.push("Article incompatible.");
  if(!need.unit||normalized(need.unit)!==normalized(lot.unit))reasons.push("Unité à compléter ou conversion à confirmer.");
  if(lot.quality!=="LIBERE")reasons.push("Lot non libéré par la qualité.");
  if(need.requirements.ownerClientId!==lot.ownerClientId)reasons.push("Propriété client incompatible.");
  if(need.requirements.grade&&normalized(need.requirements.grade)!==normalized(lot.grade))reasons.push("Nuance non vérifiée ou incompatible.");
  if(need.requirements.condition&&normalized(need.requirements.condition)!==normalized(lot.condition))reasons.push("État matière non vérifié ou incompatible.");
  for(const [dimension,value] of Object.entries(need.requirements.dimensions))if(!Number.isFinite(lot.dimensions[dimension])||lot.dimensions[dimension]<value)
    reasons.push(`Dimension ${dimension} insuffisante ou non vérifiée.`);
  for(const certificate of need.requirements.certificates)if(!lot.certificates.some(c=>normalized(c)===normalized(certificate)))reasons.push(`Certificat ${certificate} manquant.`);
  if(need.requirements.manualChecks.length&&!lot.manualVerified)reasons.push("Exigences particulières à vérifier explicitement.");
  return reasons;
}
export function materialBalance(need:MaterialNeed){
  for(const n of [need.required,need.reserved,need.consumed,need.expected,need.receivedBlocked])if(!Number.isFinite(n)||n<0)throw new Error("Invalid material balance quantity");
  const protectedQty=milli(need.reserved)+milli(need.consumed)+milli(need.expected)+milli(need.receivedBlocked);
  return {required:quantity(need.required),reserved:quantity(need.reserved),consumed:quantity(need.consumed),
    expected:quantity(need.expected),receivedBlocked:quantity(need.receivedBlocked),
    missing:Math.max(0,milli(need.required)-protectedQty)/1000,
    surplus:Math.max(0,protectedQty-milli(need.required))/1000};
}
/** Shared pool is debited as each need is proposed, including unreserved demand. */
export function proposeMaterialCoverage(needs:MaterialNeed[],lots:MaterialLot[]){
  const available=new Map(lots.map(l=>[l.batchId,milli(Math.max(0,l.available))]));
  const levels=new Map(lots.filter(l=>l.stockLevelId&&l.levelAvailable!==undefined).map(l=>[l.stockLevelId!,milli(Math.max(0,l.levelAvailable!))]));
  const released=new Map(lots.filter(l=>l.qualityAvailable!==undefined).map(l=>[l.id,milli(Math.max(0,l.qualityAvailable!))]));
  const ordered=[...lots].sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id)||a.batchId.localeCompare(b.batchId));
  return needs.map(need=>{
    const balance=materialBalance(need),selections:Array<{batchId:string;lotId:string;quantity:number}>=[];
    let missing=milli(balance.missing);
    const candidates=ordered.filter(l=>l.articleId===need.articleId).map(lot=>{
      const reasons=lotCompatibility(need,lot),free=Math.min(available.get(lot.batchId)??0,lot.stockLevelId?levels.get(lot.stockLevelId)??Infinity:Infinity,released.get(lot.id)??Infinity);
      const take=reasons.length?0:Math.min(missing,free);
      if(take>0){selections.push({batchId:lot.batchId,lotId:lot.id,quantity:take/1000});available.set(lot.batchId,(available.get(lot.batchId)??0)-take);if(lot.stockLevelId&&levels.has(lot.stockLevelId))levels.set(lot.stockLevelId,levels.get(lot.stockLevelId)!-take);if(released.has(lot.id))released.set(lot.id,released.get(lot.id)!-take);missing-=take;}
      return {lot,reasons,available:free/1000,proposed:take/1000};
    });
    return {...balance,key:need.key,candidates,selections,purchaseMissing:missing/1000};
  });
}
export function purchaseQuantity(shortage:number,minimum:number|null,pack:number|null){
  if(!Number.isFinite(shortage)||shortage<0||minimum!==null&&(!Number.isFinite(minimum)||minimum<0)||pack!==null&&(!Number.isFinite(pack)||pack<=0))throw new Error("Invalid purchase quantity policy");
  if(shortage===0)return {ordered:0,assigned:0,surplus:0};
  const base=Math.max(milli(shortage),milli(minimum??0)),step=pack===null?1:milli(pack);
  if(step<=0)throw new Error("Packaging is below stock precision");
  const ordered=Math.ceil(base/step)*step/1000;
  return {ordered,assigned:quantity(shortage),surplus:quantity(ordered-shortage)};
}
export function coverageFingerprint(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
/** JSONB may reorder object keys; evidence must survive that round trip. */
export function materialPropertiesFingerprint(value:unknown):string{
  const canonical=(input:unknown):unknown=>Array.isArray(input)?input.map(canonical):input&&typeof input==="object"?Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b,"en")).map(([key,item])=>[key,canonical(item)])):input;
  return coverageFingerprint(canonical(value));
}

export type DebitRule={form:"UNIT"|"BAR"|"SHEET";stockUnit:string;unitsPerBlank:number;kerfPerBlank:number;yieldValidated:boolean};
export function debitQuantity(rule:DebitRule,blanks:number){
  if(!Number.isSafeInteger(blanks)||blanks<=0||!Number.isFinite(rule.unitsPerBlank)||rule.unitsPerBlank<=0||!Number.isFinite(rule.kerfPerBlank)||rule.kerfPerBlank<0)throw new Error("Invalid debit rule or quantity");
  if(!rule.stockUnit.trim())throw new Error("Stock unit missing");
  if(rule.form==="SHEET"&&!rule.yieldValidated)throw new Error("Le rendement de la tôle doit être confirmé par les méthodes.");
  return quantity(blanks*(rule.unitsPerBlank+rule.kerfPerBlank));
}
