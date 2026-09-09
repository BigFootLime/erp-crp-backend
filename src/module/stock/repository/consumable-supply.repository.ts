import { assertConsumableScanTx } from './consumable-scan.repository';
import { parseIdentificationPayload } from '../../identification/domain/identification';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { coverageFingerprint,quantity } from '../../production/domain/of-material';
import { readFutureMaterialSupplyTx } from '../../production/repository/material-future-supply.repository';
import { consumableCommand } from '../../production/repository/consumable-command.repository';
import { readConsumableStockTx } from './consumable-stock.repository';
import { assertPackDepletion,consumablePurchaseQuantity } from '../domain/consumable-policy';
import { createMaterialDraftsTx } from '../../commande-fournisseur/repository/commande-fournisseur.repository';
import { repoCreateMovement,repoPostMovement,type AuditContext } from './stock.repository';
import type { ConsumableDepletion,ConsumableReplenishment } from '../validators/consumable-supply.validators';

export async function readConsumableSupplyTx(tx:Pick<PoolClient,'query'>,articleId:string){
  const article=(await tx.query<{id:string;code:string;reference:string|null;designation:string;unit:string;stock_managed:boolean;consumption_mode:'UNIT'|'GLOBAL_PACK';pack:number;version:string}>(`
    SELECT a.id::text,a.code,a.internal_reference AS reference,a.designation,a.unite AS unit,a.stock_managed,a.consumption_mode,a.purchase_pack_qty::float8 AS pack,a.updated_at::text AS version
    FROM public.articles a WHERE a.id=$1::uuid AND EXISTS(SELECT 1 FROM public.article_category_link ac WHERE ac.article_id=a.id AND ac.category_code='consommable')`,[articleId])).rows[0];
  if(!article)throw new HttpError(404,'CONSUMABLE_NOT_FOUND','Article consommable introuvable.');
  const catalogues=(await tx.query<{id:string;supplierId:string;supplierName:string;reference:string|null;unit:string;stockUnit:string|null;coefficient:number|null;price:number|null;currency:string;minimum:number|null;pack:number|null;delay:number|null;preferred:boolean;version:string}>(`
    SELECT c.id::text,c.fournisseur_id::text AS "supplierId",COALESCE(f.nom,f.raison_sociale) AS "supplierName",c.reference_fournisseur AS reference,c.unite AS unit,c.unite_stock AS "stockUnit",
      c.coef_conversion::float8 AS coefficient,c.prix_unitaire::float8 AS price,c.devise AS currency,c.moq::float8 AS minimum,c.lot_achat::float8 AS pack,c.delai_jours AS delay,
      (ap.preferred_catalogue_id=c.id) AS preferred,c.updated_at::text AS version
    FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id LEFT JOIN public.article_procurement_profile ap ON ap.article_id=c.article_id
    WHERE c.article_id=$1::uuid AND c.actif AND f.actif IS NOT FALSE AND (c.valid_from IS NULL OR c.valid_from<=current_date) AND (c.valid_to IS NULL OR c.valid_to>=current_date)
    ORDER BY (ap.preferred_catalogue_id=c.id) DESC NULLS LAST,c.updated_at DESC,c.id`,[articleId])).rows;
  const stock=await readConsumableStockTx(tx,[articleId]);
  const purchases=await readFutureMaterialSupplyTx(tx,[articleId],true);
  const destinations=(await tx.query<{id:string;name:string}>('SELECT id::text,COALESCE(code,code_magasin) AS name FROM public.magasins ORDER BY 2')).rows;
  return {article,catalogues,stock,purchases,destinations,version:coverageFingerprint({article,catalogues,stock,purchases})};
}
export async function getConsumableSupply(articleId:string){
  const tx=await pool.connect();
  try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const data=await readConsumableSupplyTx(tx,articleId);await tx.query('COMMIT');return data;}
  catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}
export async function resolveConsumableScan(scan:string){
  let entity:{type:string;id:string}|null=null;
  if(/^CERP:/i.test(scan)){
    const label=(await pool.query<{entity_type:string;entity_id:string;status:string}>(
      'SELECT entity_type,entity_id,status FROM public.identification_labels WHERE public_id=$1::uuid',[parseIdentificationPayload(scan)])).rows[0];
    if(!label||label.status!=='ACTIVE')throw new HttpError(409,'CONSUMABLE_LABEL_INACTIVE','Cette étiquette est inconnue, invalidée ou remplacée.');
    entity={type:label.entity_type,id:label.entity_id};
  }
  const items=(await pool.query<{id:string;code:string;reference:string|null;designation:string;lotId:string|null;lotCode:string|null}>(`
    SELECT DISTINCT a.id::text,a.code,a.internal_reference AS reference,a.designation,l.id::text AS "lotId",l.lot_code AS "lotCode"
    FROM public.articles a LEFT JOIN public.lots l ON l.article_id=a.id AND
      (($2='STOCK_LOT' AND l.id::text=$3) OR ($2 IS NULL AND (lower(l.lot_code)=lower($1) OR l.id::text=$1)))
    WHERE EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code='consommable')
      AND (($2='STOCK_ARTICLE' AND a.id::text=$3) OR ($2='STOCK_LOT' AND l.id IS NOT NULL)
        OR ($2 IS NULL AND (lower(a.code)=lower($1) OR lower(a.internal_reference)=lower($1) OR a.id::text=$1 OR l.id IS NOT NULL)))
    ORDER BY a.code LIMIT 20`,[scan,entity?.type??null,entity?.id??null])).rows;
  return {items};
}
function assertVersion(current:{version:string},expected:string){if(current.version!==expected)throw new HttpError(409,'CONSUMABLE_SUPPLY_CHANGED','Le stock ou un achat a changé. Relisez la situation avant de confirmer.');}
export async function replenishConsumable(articleId:string,body:ConsumableReplenishment,audit:AuditContext){
  return consumableCommand({articleId},'REPLENISH',body,audit,async tx=>{
    await tx.query('SELECT id FROM public.articles WHERE id=$1::uuid FOR UPDATE',[articleId]);
    const current=await readConsumableSupplyTx(tx,articleId);assertVersion(current,body.expectedVersion);
    if(current.purchases.length&&!body.existingPurchasesReviewed)throw new HttpError(409,'CONSUMABLE_PENDING_PURCHASES','Examinez les achats déjà attendus avant de préparer un nouvel achat.');
    const c=current.catalogues.find(c=>c.supplierId===body.supplierId);
    if(!c||(c.stockUnit??c.unit)!==current.article.unit||c.unit!==current.article.unit&&!c.coefficient)
      throw new HttpError(422,'CONSUMABLE_SUPPLIER_CONDITIONS_REQUIRED','Complétez les conditions et la conversion de ce fournisseur dans la fiche article.');
    if(body.destinationId&&!current.destinations.some(d=>d.id===body.destinationId))throw new HttpError(422,'CONSUMABLE_DESTINATION_INVALID','Choisissez un magasin existant.');
    const buy=consumablePurchaseQuantity({shortage:body.stockQuantity??current.article.pack,articlePack:current.article.pack,supplierPack:c.pack,supplierMinimum:c.minimum,coefficient:c.coefficient??1});
    const commands=await createMaterialDraftsTx(tx,[{type:'ARTICLE',needId:null,ofId:null,sourceRef:articleId,articleId,designation:current.article.designation,
      supplierId:c.supplierId,currency:c.currency,destinationId:body.destinationId,unit:c.unit,stockUnit:current.article.unit,coefficient:c.coefficient??1,
      catalogueId:c.id,supplierReference:c.reference,quantity:buy.ordered,assigned:0,price:c.price,due:null,delay:c.delay,requirements:[],operation:body.reason}],audit);
    return {commands,supply:await readConsumableSupplyTx(tx,articleId)};
  });
}
export async function depleteConsumablePack(articleId:string,body:ConsumableDepletion,audit:AuditContext){
  return consumableCommand({articleId},'PACK_FINISHED',body,audit,async tx=>{
    await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid AND article_id=$2::uuid FOR UPDATE',[body.lotId,articleId]);
    await tx.query('SELECT id FROM public.stock_levels WHERE id IN(SELECT stock_level_id FROM public.stock_batches WHERE lot_id=$1::uuid) ORDER BY id FOR UPDATE',[body.lotId]);
    const current=await readConsumableSupplyTx(tx,articleId);assertVersion(current,body.expectedVersion);
    const packs=current.stock.filter(s=>s.lotId===body.lotId&&s.pack);
    if(current.article.consumption_mode!=='GLOBAL_PACK'||!packs.length)throw new HttpError(409,'CONSUMABLE_PACK_REQUIRED','Scannez un conditionnement identifié de consommable suivi globalement.');
    await assertConsumableScanTx(tx,body.scan,{lotId:body.lotId,legacyCodes:[body.lotId,packs[0].lotCode]});
    const total=assertPackDepletion({total:quantity(packs.reduce((sum,p)=>sum+p.total,0)),reserved:quantity(packs.reduce((sum,p)=>sum+p.reserved,0)),expected:body.expectedQuantity});
    if(packs.some(p=>p.available<p.total))throw new HttpError(409,'CONSUMABLE_PACK_UNAVAILABLE','Le conditionnement est bloqué ou déprécié. Faites traiter sa situation avant de déclarer sa consommation.');
    const movementIds:string[]=[];
    for(const p of packs){
      const created=await repoCreateMovement({movement_type:'OUT',source_document_type:'MANUAL',source_document_id:body.lotId,reason_code:'PALETTE_TERMINEE',notes:body.reason,
        idempotency_key:`${body.idempotencyKey}:${p.key}:movement`,lines:[{article_id:articleId,lot_id:p.lotId,qty:p.total,unite:p.unit!,src_magasin_id:p.magasinId,src_emplacement_id:p.emplacementId,note:body.reason}]},audit,{client:tx,trusted_source_flow:true});
      const posted=await repoPostMovement(created.movement.id,{},audit,`${body.idempotencyKey}:${p.key}:post`,tx);
      if(posted?.movement.status!=='POSTED')throw new HttpError(409,'CONSUMABLE_PACK_NOT_POSTED','La sortie de cette palette n’a pas été comptabilisée.');
      movementIds.push(created.movement.id);
    }
    return {movementId:movementIds[0],movementIds,quantity:total,supply:await readConsumableSupplyTx(tx,articleId)};
  });
}
