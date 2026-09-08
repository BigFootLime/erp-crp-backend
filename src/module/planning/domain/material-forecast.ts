/** A full-order completion forecast needs the whole remaining supply. Partial
 * starts remain a separate authorization, owned by production. */
export function materialForecastAvailability(input:{now:string;required:number;consumed:number;reserved:number;blocked:number;preparation:string[];promises:Array<{quantity:number;date:string|null}>}){
  if(input.preparation.length)return {date:null,reason:input.preparation.join(' · ')};
  if(input.blocked>0)return {date:null,reason:'Matière reçue en attente de libération qualité ou d’affectation.'};
  let missing=Math.max(0,input.required-input.consumed-input.reserved);
  if(missing<1e-8)return {date:input.now,reason:null};
  const promises=input.promises.filter(p=>p.quantity>0&&p.date&&Number.isFinite(Date.parse(p.date))).sort((a,b)=>a.date!.localeCompare(b.date!));
  for(const promise of promises){
    // An overdue promise is not silently treated as a receipt today.
    if(promise.date!.slice(0,10)<input.now.slice(0,10))continue;
    missing-=promise.quantity;
    if(missing<1e-8)return {date:new Date(Math.max(Date.parse(input.now),Date.parse(`${promise.date!.slice(0,10)}T00:00:00Z`))).toISOString(),reason:null};
  }
  return {date:null,reason:'Matière restante sans date confirmée, ou promesse dépassée. Relancer le fournisseur ou le client.'};
}
