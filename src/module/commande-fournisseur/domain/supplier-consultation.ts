import {HttpError} from '../../../utils/httpError';
import type {SupplierOfferResponse} from '../validators/supplier-consultation.validators';
import {computeCommandeTotaux} from './commande-fournisseur-totaux';

export type ConsultationRequestedLine={
  id:string;designation:string;article_id:string|null;article_code:string|null;
  quantity:number;unit:string;stock_unit:string|null;coefficient:number|null;
  vat_pct:number;need_date:string|null;requirements:Array<{type:string;valeur?:string|null;obligatoire?:boolean}>;
  documents:string[];operation:string|null;of_id:number|null;
};
export type ConsultationSnapshot={code:string;currency:string;delivery_address:string|null;destination_id:string|null;freight_vat_pct:number;lines:ConsultationRequestedLine[]};

// PostgreSQL jsonb reorders object keys; compare content, never key insertion order.
export function consultationSnapshotKey(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(consultationSnapshotKey).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${consultationSnapshotKey(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function compareSupplierOffer(snapshot:ConsultationSnapshot,response:SupplierOfferResponse,today:string){
  const blocking:string[]=[];
  const requested=new Map(snapshot.lines.map(l=>[l.id,l]));
  if(response.valid_until<today)blocking.push('La validité de cette offre est dépassée.');
  if(response.lines.length!==snapshot.lines.length)blocking.push('La réponse doit couvrir toutes les lignes de cette consultation.');
  const quantities=response.lines.map(line=>{
    const need=requested.get(line.line_id);
    if(!need){blocking.push('Une ligne de réponse ne fait pas partie de la consultation.');return {lineId:line.line_id,surplus:0,late:false};}
    if(line.unit.trim().toUpperCase()!==need.unit.trim().toUpperCase())blocking.push(`${need.designation} : l’unité diffère de l’unité demandée.`);
    if(line.quantity<need.quantity)blocking.push(`${need.designation} : la quantité proposée ne couvre pas la quantité demandée.`);
    if(line.conformity!=='CONFORMING')blocking.push(`${need.designation} : conformité ${line.conformity==='TO_VERIFY'?'à vérifier':'non satisfaite'}.`);
    if(line.delivery_date<today)blocking.push(`${need.designation} : la date de livraison proposée est dépassée.`);
    return {lineId:line.line_id,surplus:Math.max(0,line.quantity-need.quantity),late:!!need.need_date&&line.delivery_date>need.need_date};
  });
  const totals=computeCommandeTotaux(response.lines.map(l=>({quantite:l.quantity,prix_unitaire_ht:l.unit_price_ht,remise_pct:l.discount_pct,frais_ht:l.fees_ht,tva_pct:requested.get(l.line_id)?.vat_pct??0,statut_ligne:'ACTIVE' as const})),{frais_port_ht:response.freight_ht,tva_frais_pct:snapshot.freight_vat_pct});
  return {blocking,quantities,totals,currency:response.currency};
}
export function assertSelectableSupplierOffer(snapshot:ConsultationSnapshot,response:SupplierOfferResponse,today:string){
  const comparison=compareSupplierOffer(snapshot,response,today);
  if(comparison.blocking.length)throw new HttpError(409,'SUPPLIER_OFFER_NOT_SELECTABLE','Cette offre ne peut pas encore être retenue.',{blocking:comparison.blocking});
  return comparison;
}
export function supplierConsultationRequest(snapshot:ConsultationSnapshot,supplierName:string,notes:string){
  return [`Objet : Consultation matière — ${snapshot.code}`,`Bonjour ${supplierName},`,
    'Merci de nous transmettre votre offre avec prix, quantité, unité, date de livraison, durée de validité et conformité aux exigences ci-dessous.',
    ...snapshot.lines.flatMap((l,i)=>[
      `${i+1}. ${l.article_code?`${l.article_code} — `:''}${l.designation} : ${l.quantity} ${l.unit}${l.need_date?`, nécessaire le ${l.need_date}`:''}`,
      ...l.requirements.map(r=>`Exigence${r.obligatoire?' obligatoire':''} : ${r.valeur||r.type}`),
      ...l.documents.map(d=>`Document attendu : ${d}`),
    ]),snapshot.delivery_address?`Livraison : ${snapshot.delivery_address}`:'',notes,
    'Merci de signaler les minimums de commande, conditionnements, frais de transport et écarts éventuels.'].filter(Boolean).join('\n\n');
}
