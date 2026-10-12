import {createHash} from "node:crypto";
import {physicalMaterialHeldCapacity,physicalMaterialSelection,type MaterialBarCoverage} from './of-material-bars';
import type {MaterialBarAllocation} from '../../stock/domain/material-bars';

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
  barInventory?:MaterialBarCoverage;
};
export type MaterialNeed={
  key:string; articleId:string|null; unit:string|null; required:number; requirements:MaterialRequirements;
  reserved:number; consumed:number; expected:number; receivedBlocked:number;
  debitRule?:DebitRule|null;
  reservations?:ReadonlyArray<{id:string;stock_batch_id:string|null;status:string;unexpired:boolean;qty_reserved:number;qty_consumed:number}>;
  barInventories?:Record<string,MaterialBarCoverage>;
};
export function barBlankStep(need:Pick<MaterialNeed,'debitRule'>){
  const rule=need.debitRule;
  return rule?.form==='BAR'&&rule.unitsPerBlank>0&&rule.kerfPerBlank>=0
    ?milli(rule.unitsPerBlank+rule.kerfPerBlank):0;
}
/** Reservations are accounting holds, not physical bar boundaries. Holds may
 * combine only within the same batch; lengths from different batches never do. */
export function materialReservedByBatch(need:Pick<MaterialNeed,'reservations'>){
  const held=new Map<string,number>();
  for(const r of need.reservations??[]){
    if(r.status!=='ACTIVE'||!r.unexpired)continue;
    const key=r.stock_batch_id??`reservation:${r.id}`;
    held.set(key,(held.get(key)??0)+milli(Math.max(0,Number(r.qty_reserved)-Number(r.qty_consumed))));
  }
  return held;
}
export function materialReservedCapacity(need:Pick<MaterialNeed,'debitRule'|'reservations'|'reserved'|'barInventories'>){
  const step=barBlankStep(need);
  if(step&&need.barInventories)return physicalMaterialHeldCapacity(need);
  if(!step||!need.reservations)return quantity(need.reserved);
  return [...materialReservedByBatch(need).values()].reduce((sum,q)=>sum+Math.floor(q/step)*step,0)/1000;
}
/** A small top-up can complete a blank using the remainder already held on the
 * same source (210 + 11 = 2 x 110.5). It must not buy that remainder again. */
export function materialSelectionCoverage(need:MaterialNeed,selections:ReadonlyArray<{batchId:string;quantity:number}>){
  const step=barBlankStep(need);
  if(!step)return quantity(selections.reduce((sum,s)=>sum+s.quantity,0));
  const held=materialReservedByBatch(need),added=new Map<string,number>();
  for(const s of selections)added.set(s.batchId,(added.get(s.batchId)??0)+milli(s.quantity));
  if(need.barInventories)return quantity([...added].reduce((sum,[batch,q])=>sum+physicalMaterialSelection(need,batch,q/1000).coverage,0));
  return [...added].reduce((sum,[batch,q])=>{
    const before=held.get(batch)??0;
    return sum+(Math.floor((before+q)/step)-Math.floor(before/step))*step;
  },0)/1000;
}
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
  const usableReserved=materialReservedCapacity(need);
  const protectedQty=milli(usableReserved)+milli(need.consumed)+milli(need.expected)+milli(need.receivedBlocked);
  return {required:quantity(need.required),reserved:quantity(need.reserved),consumed:quantity(need.consumed),
    usableReserved,
    expected:quantity(need.expected),receivedBlocked:quantity(need.receivedBlocked),
    missing:Math.max(0,milli(need.required)-protectedQty)/1000,
    surplus:Math.max(0,protectedQty-milli(need.required))/1000};
}
/** Shared pool is debited as each need is proposed, including unreserved demand. */
export function proposeMaterialCoverage<T extends MaterialLot>(needs:MaterialNeed[],lots:T[],originPolicy?:{
  maximumLots:number;usedOrigins:Set<string>;originsByLot:Record<string,string[]>;
},proposedBarAvailability=new Map<string,number>()){
  const available=new Map(lots.map(l=>[l.batchId,milli(Math.max(0,l.available))]));
  const levels=new Map(lots.filter(l=>l.stockLevelId&&l.levelAvailable!==undefined).map(l=>[l.stockLevelId!,milli(Math.max(0,l.levelAvailable!))]));
  const released=new Map(lots.filter(l=>l.qualityAvailable!==undefined).map(l=>[l.id,milli(Math.max(0,l.qualityAvailable!))]));
  const ordered=[...lots].sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id)||a.batchId.localeCompare(b.batchId));
  for(const need of needs)for(const inventory of Object.values(need.barInventories??{}))for(const bar of inventory.bars){
    if(!proposedBarAvailability.has(bar.id))proposedBarAvailability.set(bar.id,
      Math.max(0,milli(bar.lengthMm)-inventory.holds.filter(h=>h.barId===bar.id).reduce((sum,h)=>sum+milli(h.remainingMm),0))/1000);
  }
  return needs.map(need=>{
    const balance=materialBalance(need),selections:Array<{batchId:string;lotId:string;quantity:number;barAllocations?:MaterialBarAllocation[]}>=[];
    let missing=milli(balance.missing);
    const step=barBlankStep(need),held=materialReservedByBatch(need);
    const candidates=ordered.filter(l=>l.articleId===need.articleId).map(lot=>{
      const reasons=lotCompatibility(need,lot),free=Math.min(available.get(lot.batchId)??0,lot.stockLevelId?levels.get(lot.stockLevelId)??Infinity:Infinity,released.get(lot.id)??Infinity);
      const roots=originPolicy?.originsByLot[lot.id]??[lot.id];
      const originAllowed=!originPolicy||(roots.length>0&&new Set([...originPolicy.usedOrigins,...roots]).size<=originPolicy.maximumLots);
      const geometry=step&&need.barInventories?need.barInventories[lot.batchId]:undefined;
      const geometryPending=!!(step&&need.barInventories&&geometry?.status!=='CONFIRMED');
      if(geometryPending)reasons.push(geometry?.warning??'Confirmez les barres physiques de ce lot.');
      const remainder=step?(held.get(lot.batchId)??0)%step:0;
      const blanks=step?Math.min(Math.ceil(missing/step),Math.floor((free+remainder)/step)):0;
      const physical=geometry?.status==='CONFIRMED'?physicalMaterialSelection(need,lot.batchId,free/1000,proposedBarAvailability,Math.ceil(missing/step)):undefined;
      const take=reasons.length||!originAllowed?0:physical?milli(physical.quantity):step?(blanks>0?blanks*step-remainder:0):Math.min(missing,free);
      if(take>0){
        roots.forEach(root=>originPolicy?.usedOrigins.add(root));
        selections.push({batchId:lot.batchId,lotId:lot.id,quantity:take/1000,...(physical?{barAllocations:physical.allocations}:{})});
        for(const a of physical?.allocations??[])proposedBarAvailability.set(a.barId,quantity((proposedBarAvailability.get(a.barId)??0)-a.quantityMm));
        available.set(lot.batchId,(available.get(lot.batchId)??0)-take);
        if(lot.stockLevelId&&levels.has(lot.stockLevelId))levels.set(lot.stockLevelId,levels.get(lot.stockLevelId)!-take);
        if(released.has(lot.id))released.set(lot.id,released.get(lot.id)!-take);
        missing=Math.max(0,missing-(physical?milli(physical.coverage):step?blanks*step:take));
      }
      return {lot,reasons,available:free/1000,proposed:take/1000,geometryPending};
    });
    const purchaseRequiresBarReview=missing>0&&candidates.some(c=>c.geometryPending&&c.available>0&&lotCompatibility(need,c.lot).length===0);
    return {...balance,key:need.key,candidates,selections,purchaseMissing:missing/1000,purchaseRequiresBarReview};
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
