import { assertConsumableScanTx } from '../../stock/repository/consumable-scan.repository';
import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { quantity } from '../domain/of-material';
import { consumablePurchaseQuantity } from '../../stock/domain/consumable-policy';
import { repoCreateStockReservation } from '../../stock/repository/stock-reservation.repository';
import { createMaterialDraftsTx,type MaterialDraftLine } from '../../commande-fournisseur/repository/commande-fournisseur.repository';
import { allocateFutureMaterialSupplyTx,lockFutureMaterialSupplyTx } from './material-future-supply.repository';
import { readOfConsumablesTx } from './consumable-procurement-read.repository';
import { consumableCommand } from './consumable-command.repository';
import type { AuditContext } from './production.repository';
import type { ConsumableConfiguration,ConsumablePreparation,ConsumableReconciliation,ConsumableWithdrawal } from '../validators/consumable-procurement.validators';
import { consumeMaterialReservationTx } from '../../stock/repository/partial-reservation-consumption.repository';
import {groupConsumableDrafts,type ConsumableDraftRequest} from '../domain/consumable-draft-groups';

type Coverage=Awaited<ReturnType<typeof readOfConsumablesTx>>;
type Need=Coverage['needs'][number];
function assertVersion(current:Coverage,expected:string){
  if(current.version!==expected)throw new HttpError(409,'CONSUMABLE_COVERAGE_CHANGED','Le stock, les achats ou la version de l’OF ont changé. Actualisez la proposition.');
}
function assertNeed(current:Coverage,key:string){
  const need=current.needs.find(n=>n.key===key);
  if(!need)throw new HttpError(404,'CONSUMABLE_NEED_NOT_FOUND','Ce besoin n’existe pas dans la version figée de l’OF.');
  if(need.blockers.length||!need.articleId||!need.unit||!current.technicalVersion||!current.technicalHash)
    throw new HttpError(409,'CONSUMABLE_DEFINITION_REQUIRED',need.blockers.join(' ')||'Complétez la définition du consommable.');
  return need;
}
async function saveNeed(tx:PoolClient,current:Coverage,need:Need,audit:AuditContext,supplierId=need.supplierId,destinationId=need.destinationId){
  // OF revisions evolve independently from the immutable technical snapshot.
  // Preserve the previous revision's commitments until explicit reconciliation.
  await tx.query(`UPDATE public.of_material_needs SET superseded_at=now(),updated_at=now(),updated_by=$5
    WHERE of_id=$1 AND technical_version_id=$2::uuid AND source_ref=$3 AND (technical_hash<>$4 OR of_revision_id IS DISTINCT FROM $6::uuid) AND superseded_at IS NULL`,
    [current.ofId,current.technicalVersion,need.key,current.technicalHash,audit.user_id,current.ofRevisionId]);
  const result=await tx.query<{id:string}>(`INSERT INTO public.of_material_needs(of_id,source_ref,technical_version_id,technical_hash,article_id,designation,required_qty,unit,
      supply_mode,requirements,specification_reviewed_at,specification_reviewed_by,supplier_id,destination_id,created_by,updated_by,need_kind,consumption_mode,stock_managed,receipt_quality_required,of_revision_id)
    VALUES($1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,'PURCHASE','{}'::jsonb,now(),$9,$10::uuid,$11::uuid,$9,$9,'CONSOMMABLE',$12,$13,$14,$15::uuid)
    ON CONFLICT(of_id,technical_version_id,source_ref) WHERE superseded_at IS NULL DO UPDATE SET supplier_id=EXCLUDED.supplier_id,destination_id=EXCLUDED.destination_id,
      row_version=of_material_needs.row_version+1,updated_at=now(),updated_by=EXCLUDED.updated_by RETURNING id::text`,
    [current.ofId,need.key,current.technicalVersion,current.technicalHash,need.articleId,need.designation,need.required,need.unit,audit.user_id,supplierId,destinationId,
      need.policy!.consumption_mode,need.policy!.stock_managed,need.policy!.receipt_quality_required,current.ofRevisionId]);
  return result.rows[0].id;
}

export async function configureOfConsumable(ofId:number,body:ConsumableConfiguration,audit:AuditContext){
  return consumableCommand({ofId},'CONFIGURE',body,audit,async tx=>{
    const current=await readOfConsumablesTx(tx,ofId);assertVersion(current,body.expectedVersion);
    // A changed supplier can repair conversion blockers. Frozen identity still must match.
    const found=current.needs.find(n=>n.key===body.sourceRef);
    const catalogue=found?.catalogues.find(c=>c.supplier_id===body.supplierId);
    if(body.supplierId&&(!catalogue||(catalogue.stock_unit??catalogue.unit)!==found?.unit||catalogue.unit!==found?.unit&&!catalogue.coefficient))
      throw new HttpError(422,'CONSUMABLE_SUPPLIER_CONDITIONS_REQUIRED','Ajoutez les conditions et la conversion de ce fournisseur dans la fiche article.');
    const compatible={...current,needs:current.needs.map(n=>n.key===body.sourceRef?{...n,blockers:n.blockers.filter(b=>!b.includes('conversion')&&!b.includes('coefficient'))}:n)};
    const need=assertNeed(compatible,body.sourceRef);
    if(body.destinationId&&!current.destinations.some(d=>d.id===body.destinationId))throw new HttpError(422,'CONSUMABLE_DESTINATION_INVALID','Choisissez un magasin existant.');
    if(need.destinationId!==body.destinationId&&(need.reserved+need.consumed+need.expected+need.receivedBlocked+need.receivedAccepted>0))
      throw new HttpError(409,'CONSUMABLE_DESTINATION_COMMITTED','Des engagements existent dans ce magasin. Rapprochez-les avant de changer de destination.');
    // Existing order lines keep their confirmed supplier and price.
    await saveNeed(tx,current,need,audit,body.supplierId,body.destinationId);
    return readOfConsumablesTx(tx,ofId);
  });
}

export async function prepareOfConsumables(ofId:number,body:ConsumablePreparation,audit:AuditContext,rights:{reserve:boolean;purchase:boolean}){
  return consumableCommand({ofId},'PREPARE',body,audit,async tx=>{
    let current=await readOfConsumablesTx(tx,ofId);assertVersion(current,body.expectedVersion);
    if(current.dossierStatus!=='COMPLETE')throw new HttpError(409,'OF_DOSSIER_INCOMPLETE','Validez le dossier Complet avant de préparer ses approvisionnements.');
    if(current.previousNeeds.length)throw new HttpError(409,'CONSUMABLE_PREVIOUS_REVISION','Rapprochez les engagements des versions précédentes avant de préparer de nouveaux achats.');
    await lockFutureMaterialSupplyTx(tx,body.needs.flatMap(n=>n.future.map(f=>f.lineId)));
    const lots=current.needs.flatMap(n=>body.needs.some(b=>b.key===n.key)?n.candidates.flatMap(c=>c.lotId?[c.lotId]:[]):[]);
    await tx.query('SELECT id FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lots]);
    const levels=current.needs.flatMap(n=>body.needs.some(b=>b.key===n.key)?n.candidates.map(c=>c.levelId):[]);
    await tx.query('SELECT id FROM public.stock_levels WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[levels]);
    current=await readOfConsumablesTx(tx,ofId);assertVersion(current,body.expectedVersion);
    const drafts:ConsumableDraftRequest[]=[],reservedIds:string[]=[],pending:Array<{key:string;message:string}>=[];
    const sharedPrepared=new Set<string>();
    for(const choice of body.needs){
      if(choice.reserve&&!rights.reserve||choice.future.length&&!rights.purchase||choice.purchase&&!rights.purchase)
        throw new HttpError(403,'CONSUMABLE_PREPARATION_FORBIDDEN','Les droits de réservation ou d’achat nécessaires ne sont pas accordés.');
      // Re-read after each need, so the same stock/purchase cannot cover two lines.
      const live=await readOfConsumablesTx(tx,ofId),need=assertNeed(live,choice.key);
      const needId=need.id??await saveNeed(tx,live,need,audit);
      if(need.mode==='GLOBAL_PACK'&&choice.future.length)throw new HttpError(422,'SHARED_CONSUMABLE_ALLOCATION_FORBIDDEN','Les palettes sont disponibles en commun et ne sont pas affectées à un OF.');
      let remaining=need.missing;
      if(choice.reserve&&need.mode==='UNIT')for(const selection of need.selections){
        const c=selection.candidate;
        const result=await repoCreateStockReservation({article_id:need.articleId!,magasin_id:c.magasinId,emplacement_id:c.emplacementId,
          lot_id:c.lotId,qty:selection.quantity,source:{source_type:'OF',of_id:ofId},reason:`Consommable ${live.number} · ${need.designation}`},
          audit,`${body.idempotencyKey}:${need.key}:${c.key}`,tx,needId);
        reservedIds.push(result.reservation.id);remaining=quantity(remaining-selection.quantity);
      }
      if(new Set(choice.future.map(f=>f.lineId)).size!==choice.future.length)throw new HttpError(422,'CONSUMABLE_DUPLICATE_PURCHASE','Un achat ne peut être sélectionné deux fois pour ce besoin.');
      for(const selected of choice.future){
        const source=need.futureSupplies.find(f=>f.id===selected.lineId&&f.compatible);
        if(!source||selected.quantity>remaining)throw new HttpError(409,'CONSUMABLE_FUTURE_SUPPLY_CHANGED','Cet achat est incompatible ou dépasse le besoin restant.');
        await allocateFutureMaterialSupplyTx(tx,{lineId:selected.lineId,needId,sourceRef:need.key,ofId,quantity:selected.quantity});
        remaining=quantity(remaining-selected.quantity);
      }
      if(!choice.purchase)continue;
      if(need.mode==='GLOBAL_PACK'){
        if(!need.replenishmentSuggested||sharedPrepared.has(need.articleId!))continue;
        remaining=need.purchase.assigned;
      }else if(remaining>0&&need.futureSupplies.some(f=>f.compatible&&!choice.future.some(s=>s.lineId===f.id))&&!choice.existingPurchasesReviewed)
        throw new HttpError(409,'CONSUMABLE_EXISTING_PURCHASE_REVIEW','Un achat attendu est disponible. Examinez son affectation avant de créer une nouvelle commande.');
      if(remaining<=0)continue;
      if(!need.supplierId||!need.catalogue){pending.push({key:need.key,message:'Choisissez ou créez un fournisseur et ses conditions pour préparer le brouillon.'});continue;}
      const c=need.catalogue;
      const articlePack=(await tx.query<{pack:number}>('SELECT purchase_pack_qty::float8 AS pack FROM public.articles WHERE id=$1::uuid',[need.articleId])).rows[0].pack;
      const buy=consumablePurchaseQuantity({shortage:remaining,articlePack,supplierMinimum:c.minimum,supplierPack:c.pack,coefficient:c.coefficient??1});
      drafts.push({shortage:remaining,articlePack,supplierMinimum:c.minimum,supplierPack:c.pack,line:{type:'ARTICLE',needId:need.mode==='GLOBAL_PACK'?null:needId,ofId:need.mode==='GLOBAL_PACK'?null:ofId,sourceRef:need.key,articleId:need.articleId!,
        designation:need.designation,supplierId:need.supplierId,currency:c.currency,destinationId:need.destinationId,unit:c.unit!,stockUnit:need.unit!,coefficient:c.coefficient??1,
        catalogueId:c.id,supplierReference:c.reference,quantity:buy.ordered,assigned:need.mode==='GLOBAL_PACK'?0:buy.assigned,price:c.price,due:null,delay:c.delay,
        requirements:[],operation:need.mode==='GLOBAL_PACK'?'Réapprovisionnement partagé':'Consommable OF'}});
      if(need.mode==='GLOBAL_PACK')sharedPrepared.add(need.articleId!);
    }
    const commands=await createMaterialDraftsTx(tx,groupConsumableDrafts(drafts),audit);
    return {coverage:await readOfConsumablesTx(tx,ofId),commands,reservedIds,pending};
  });
}

export async function withdrawOfConsumable(ofId:number,body:ConsumableWithdrawal,audit:AuditContext){
  return consumableCommand({ofId},'WITHDRAW',body,audit,async tx=>{
    const current=await readOfConsumablesTx(tx,ofId);assertVersion(current,body.expectedVersion);
    const need=current.needs.find(n=>n.reservations.some(r=>r.id===body.reservationId));
    if(!need||need.mode!=='UNIT'||!need.id)throw new HttpError(409,'CONSUMABLE_RESERVATION_REQUIRED','Choisissez une réservation de consommable suivi à l’unité pour cet OF.');
    assertNeed(current,need.key);
    const reservation=need.reservations.find(r=>r.id===body.reservationId)!;
    await assertConsumableScanTx(tx,body.scan,{articleId:need.articleId,lotId:reservation.lotId,legacyCodes:[need.articleId,need.articleCode,need.reference,reservation.lotId,reservation.lotCode]});
    const result=await consumeMaterialReservationTx(tx,{reservationId:body.reservationId,ofId,operationId:null,kind:'CONSOMMABLE',quantity:body.quantity,
      expectedVersion:body.reservationVersion,idempotencyKey:`${body.idempotencyKey}:withdraw`,reason:body.reason},audit);
    return {...result,coverage:await readOfConsumablesTx(tx,ofId)};
  });
}

export async function reconcileOfConsumables(ofId:number,body:ConsumableReconciliation,audit:AuditContext){
  return consumableCommand({ofId},'RECONCILE',body,audit,async tx=>{
    const current=await readOfConsumablesTx(tx,ofId);assertVersion(current,body.expectedVersion);
    const previous=current.previousNeeds.find(n=>n.id===body.previousNeedId);
    if(!previous)throw new HttpError(409,'CONSUMABLE_REVISION_CHANGED','Cet engagement a déjà été rapproché ou n’appartient pas à une version précédente.');
    let targetId:string|null=null;
    if(body.disposition==='CARRY'){
      if(!body.targetKey)throw new HttpError(422,'CONSUMABLE_REVISION_TARGET_REQUIRED','Choisissez le besoin de la nouvelle version.');
      const target=assertNeed(current,body.targetKey);
      if(previous.article_id!==target.articleId||previous.unit!==target.unit||previous.stock_managed!==target.policy!.stock_managed||previous.consumption_mode!==target.policy!.consumption_mode||previous.receipt_quality_required!==target.policy!.receipt_quality_required||previous.destination_id!==target.destinationId)
        throw new HttpError(409,'CONSUMABLE_REVISION_INCOMPATIBLE','L’article, l’unité, le mode, la qualité et la destination doivent correspondre pour reporter ces engagements.');
      const committed=previous.reservations.reduce((sum,r)=>sum+(r.status==='CONSUMED'?r.reserved:r.consumed+(r.status==='ACTIVE'&&r.unexpired?Math.max(0,r.reserved-r.consumed):0)),0)+previous.promises.reduce((sum,p)=>sum+Math.max(0,p.assigned-p.transferred),0);
      if(quantity(committed+target.reserved+target.consumed+target.expected+target.receivedBlocked+target.receivedAccepted)>target.required)
        throw new HttpError(409,'CONSUMABLE_REVISION_SURPLUS','Les engagements dépassent le nouveau besoin. Conservez-les séparément pour traiter le surplus explicitement.');
      targetId=target.id??await saveNeed(tx,current,target,audit);
    }
    await tx.query('UPDATE public.of_material_needs SET superseded_at=COALESCE(superseded_at,now()),updated_at=now(),updated_by=$2 WHERE id=$1::uuid',[previous.id,audit.user_id]);
    await tx.query(`INSERT INTO public.of_material_revision_resolutions(of_id,previous_need_id,target_need_id,disposition,reason,reviewed_snapshot,created_by,consumable_command_key)
      VALUES($1,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8::uuid)`,[ofId,previous.id,targetId,body.disposition,body.reason,JSON.stringify(previous),audit.user_id,body.idempotencyKey]);
    return readOfConsumablesTx(tx,ofId);
  });
}
