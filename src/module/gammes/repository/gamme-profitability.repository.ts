import db from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { profitability } from '../domain/gamme-profitability';
import { ofDocumentMaterialCutting } from '../../production/domain/of-document-technical-source';

const money=(value:number)=>Math.round(value*100)/100;
const numeric=(value:unknown):number|null=>value===null||value===undefined?null:Number.isFinite(Number(value))?Number(value):null;

export async function repoGammeProfitability(gammeId:string,quantity:number){
 const tx=await db.connect();
 try{
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const context=(await tx.query<{piece_id:string;version_id:string;prix_unitaire:string|null;ensemble:boolean}>(`SELECT p.id::text AS piece_id,g.piece_technique_version_id::text AS version_id,p.prix_unitaire,p.ensemble FROM public.gammes g JOIN public.piece_technique_versions v ON v.id=g.piece_technique_version_id JOIN public.pieces_techniques p ON p.id=v.piece_technique_id WHERE g.id=$1::uuid`,[gammeId])).rows[0];
  if(!context)throw new HttpError(404,'NOT_FOUND','Gamme introuvable.');
  const operations=(await tx.query(`SELECT o.id::text,o.phase,o.type_operation,o.tp,o.tf_unit,o.qte,o.coef,o.taux_horaire,o.taux_horaire_source,o.prix_vente_horaire,COALESCE(cf.devise,'EUR') AS devise FROM public.pieces_techniques_operations o LEFT JOIN public.centres_frais cf ON cf.id=o.cf_id WHERE o.gamme_id=$1::uuid ORDER BY o.ordre,o.id`,[gammeId])).rows;
  const purchases=(await tx.query(`SELECT id::text,designation,type_achat,quantite,unite_prix,longueur_mm,quantite_pieces,COALESCE(pu_achat,prix) AS unit_price FROM public.pieces_techniques_achats WHERE piece_technique_id=$1::uuid AND piece_technique_version_id=$2::uuid ORDER BY id`,[context.piece_id,context.version_id])).rows;
  const missing:string[]=[];
  if(context.ensemble)missing.push('Coût des sous-ensembles non inclus dans cette gamme');
  if(!operations.length)missing.push('Aucune opération dans la gamme');
  const opMargins=operations.map(op=>{
   const hours=Number(op.tp??0)+Number(op.tf_unit??0)*Number(op.qte??1)*Number(op.coef??1)*quantity;
   const rate=op.taux_horaire_source&&op.taux_horaire_source!=='ABSENT'?numeric(op.taux_horaire):null;
   const cost=hours===0?0:rate===null?null:money(hours*rate);
   const selling=numeric(op.prix_vente_horaire);
   if(cost===null)missing.push(`Tarif de coût manquant · OP ${op.phase??'—'}`);
   if(['FRAISAGE','TOURNAGE'].includes(op.type_operation)&&Number(op.tf_unit??0)<=0)missing.push(`Temps unitaire à renseigner · OP ${op.phase??'—'}`);
   if(op.devise!=='EUR')missing.push(`Conversion de devise requise · OP ${op.phase??'—'}`);
   return {operation_id:op.id,quantity,hours,cost_rate:rate,selling_rate:selling,currency:op.devise,...profitability(selling===null?null:money(hours*selling),cost)};
  });
  const purchaseCosts=purchases.map(p=>{
   const cutting=p.type_achat==='MATIERE'?ofDocumentMaterialCutting(p,quantity):null;
   const unit=String(p.unite_prix??'').toUpperCase();
   let need=Number(p.quantite??0)*quantity;
   if(cutting&&['MM','M','U'].includes(unit)){
    if(unit==='U')need=cutting.nombreBruts;
    else if(cutting.longueurTotaleMm!==null)need=cutting.longueurTotaleMm/(unit==='M'?1000:1);
    else {missing.push(`Longueur de coupe manquante · ${p.designation??p.id}`);need=NaN;}
   }
   const price=numeric(p.unit_price);
   const cost=need===0?0:!Number.isFinite(need)||price===null?null:money(need*price);
   if(cost===null)missing.push(`Prix d'achat ou quantité manquant · ${p.designation??p.id}`);
   return {purchase_id:p.id,quantity:Number.isFinite(need)?need:null,unit,cost,cutting};
  });
  const labour=money(opMargins.reduce((sum,op)=>sum+(op.currency==='EUR'?(op.cost??0):0),0));
  const purchasesTotal=money(purchaseCosts.reduce((sum,p)=>sum+(p.cost??0),0));
  const sellingPrice=numeric(context.prix_unitaire);
  const partPrice=sellingPrice!==null&&sellingPrice>0?sellingPrice:null;
  if(partPrice===null)missing.push('Prix de vente de la pièce non renseigné');
  const allCostsKnown=missing.every(reason=>reason==='Prix de vente de la pièce non renseigné');
  const result={gamme_id:gammeId,piece_id:context.piece_id,quantity,currency:'EUR',part_unit_price:partPrice,operation_cost:labour,purchase_cost:purchasesTotal,known_cost:money(labour+purchasesTotal),missing,
   global:profitability(partPrice===null?null:money(partPrice*quantity),allCostsKnown?money(labour+purchasesTotal):null),operations:opMargins,purchases:purchaseCosts,
   basis:'Réglage compté une fois pour le lot ; temps unitaire et achats appliqués à la quantité. Marge sur prix de vente HT. Hors frais non présents dans le dossier.'};
  await tx.query('COMMIT');return result;
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
