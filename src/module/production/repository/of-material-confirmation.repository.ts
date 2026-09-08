import {materialCommand,readMaterialTx,type Candidate} from './of-material.repository';
import type {MaterialConfirmation} from '../validators/of-material.validators';
import type {AuditContext} from './production.repository';
import {quantity,materialBalance,lotCompatibility,purchaseQuantity} from '../domain/of-material';
import {HttpError} from '../../../utils/httpError';
import {repoCreateStockReservation} from '../../stock/repository/stock-reservation.repository';
import {createMaterialDraftsTx,type MaterialDraftLine} from '../../commande-fournisseur/repository/commande-fournisseur.repository';
import {lockFutureMaterialSupplyTx,allocateFutureMaterialSupplyTx} from './material-future-supply.repository';

export async function confirmOfMaterial(ofId:number,body:MaterialConfirmation,audit:AuditContext,canPurchase:boolean){
  return materialCommand(ofId,"CONFIRM",body,audit,async(tx,current)=>{
    if(current.needs.some(n=>n.blockers.length))throw new HttpError(409,"MATERIAL_PREPARATION_REQUIRED","Complétez les besoins matière avant de confirmer la couverture.");
    if(current.previousNeeds.length)throw new HttpError(409,"MATERIAL_PREVIOUS_REVISION","Les affectations de l’ancienne version doivent être revues avant une nouvelle couverture.");
    if(new Set(body.selections.map(s=>`${s.needKey}:${s.batchId}`)).size!==body.selections.length)throw new HttpError(422,"MATERIAL_DUPLICATE_SELECTION","Le même lot est présent deux fois pour ce besoin.");
    if(new Set(body.futureSelections.map(s=>`${s.needKey}:${s.lineId}`)).size!==body.futureSelections.length)throw new HttpError(422,'MATERIAL_DUPLICATE_SELECTION','Le même approvisionnement est présent deux fois pour ce besoin.');
    await lockFutureMaterialSupplyTx(tx,body.futureSelections.map(s=>s.lineId));
    // Stabilize quality and material properties before rechecking the preview.
    const batchIds=body.selections.map(s=>s.batchId);
    await tx.query("SELECT id FROM public.lots WHERE id IN (SELECT lot_id FROM public.stock_batches WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE",[batchIds]);
    const locked=await readMaterialTx(tx,ofId);
    if(locked.version!==current.version)throw new HttpError(409,"MATERIAL_COVERAGE_CHANGED","Un lot ou un approvisionnement a changé. Actualisez la proposition.");
    const drafts:MaterialDraftLine[]=[],reservedIds:string[]=[],pending:Array<{needKey:string;message:string}>=[];
    const allocatedFuture=new Map<string,number>();
    for(const need of current.needs){
      const selections=body.selections.filter(s=>s.needKey===need.key),total=quantity(selections.reduce((sum,s)=>sum+s.quantity,0));
      const futureSelections=body.futureSelections.filter(s=>s.needKey===need.key),futureTotal=quantity(futureSelections.reduce((sum,s)=>sum+s.quantity,0));
      if(quantity(total+futureTotal)>materialBalance(need).missing)throw new HttpError(409,"MATERIAL_OVER_COVERAGE","La sélection physique et attendue dépasse le manque restant.");
      for(const selection of futureSelections){
        const candidate=need.futureSupplies.find(s=>s.id===selection.lineId),already=allocatedFuture.get(selection.lineId)??0;
        if(!selection.requirementsReviewed||!candidate||candidate.reasons.length||quantity(already+selection.quantity)>candidate.available)
          throw new HttpError(409,'MATERIAL_FUTURE_SUPPLY_CHANGED','L’approvisionnement attendu n’est plus compatible ou disponible. Relisez la proposition.');
        await allocateFutureMaterialSupplyTx(tx,{lineId:selection.lineId,needId:need.id!,sourceRef:need.key,ofId,quantity:selection.quantity});
        allocatedFuture.set(selection.lineId,quantity(already+selection.quantity));
      }
      for(const selection of selections){
        const candidate=need.candidates.find(c=>c.lot.batchId===selection.batchId);
        if(!candidate||lotCompatibility(need,candidate.lot).length||selection.quantity>candidate.available)throw new HttpError(409,"MATERIAL_LOT_CHANGED","Un lot sélectionné n’est plus compatible ou disponible.");
        const lot=candidate.lot as Candidate;
        const result=await repoCreateStockReservation({article_id:need.articleId!,magasin_id:lot.magasinId,emplacement_id:lot.emplacementId,lot_id:lot.id,qty:selection.quantity,source:{source_type:"OF",of_id:ofId},reason:`Matière ${current.number} · ${need.operationLabel}`},audit,`${body.idempotencyKey}:${need.key}:${lot.batchId}`,tx,need.id!);
        reservedIds.push(result.reservation.id);
      }
      const buy=purchaseQuantity(quantity(materialBalance(need).missing-total-futureTotal),need.catalog?.moq??null,need.catalog?.lot_achat??null);
      if(!buy.assigned)continue;
      if(need.supplyMode==="CUSTOMER"){pending.push({needKey:need.key,message:`Préparer l’appel de ${buy.assigned} ${need.unit} au client.`});continue;}
      if(!canPurchase){pending.push({needKey:need.key,message:"Faire préparer le brouillon par un utilisateur habilité aux achats."});continue;}
      if(!need.supplierId||need.price===null){pending.push({needKey:need.key,message:!need.supplierId?"Choisir le fournisseur pour préparer le brouillon.":"Renseigner le prix fournisseur ou consulter les fournisseurs."});continue;}
      drafts.push({needId:need.id!,sourceRef:need.key,ofId,articleId:need.articleId!,designation:need.designation,supplierId:need.supplierId,currency:need.currency,destinationId:need.destinationId,unit:need.unit!,quantity:buy.ordered,assigned:buy.assigned,price:need.price,due:current.operations.find(o=>o.id===need.operationId)?.start?.slice(0,10)??null,operation:need.operationLabel!,requirements:[need.requirements.grade,need.requirements.condition,...Object.entries(need.requirements.dimensions).map(([name,value])=>`${name} : ${value} mm minimum`),...need.requirements.certificates,...need.requirements.manualChecks].filter((x):x is string=>!!x)});
    }
    if([...body.selections,...body.futureSelections].some(s=>!current.needs.some(n=>n.key===s.needKey)))throw new HttpError(422,"MATERIAL_NEED_NOT_FOUND","Le besoin sélectionné n’existe plus.");
    const commands=await createMaterialDraftsTx(tx,drafts,audit);
    return {coverage:await readMaterialTx(tx,ofId),commands,reservedIds,pending,futureAssigned:body.futureSelections};
  });
}

