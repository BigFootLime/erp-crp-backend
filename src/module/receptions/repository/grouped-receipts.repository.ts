import type { PoolClient } from 'pg';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { getDocumentStoragePath,resolveCerpStoragePath } from '../../../utils/cerpStorage';
import { consumableCommand } from '../../production/repository/consumable-command.repository';
import { lockFutureMaterialSupplyTx } from '../../production/repository/material-future-supply.repository';
import { lockMaterialReceiptRecipientsTx } from '../../production/repository/of-material-receipts.repository';
import { repoCreateReception,repoCreateLine,repoCreateLotForLine,repoCreateStockReceiptLocked,type AuditContext } from './receptions.repository';
import { readExpectedReceiptLinesTx } from './expected-receipts.repository';
import { readOffStockSurplusTx } from './off-stock-surplus.repository';
import type { PrepareGroupedReceipt,ConfirmGroupedReceipt } from '../validators/grouped-receipts.validators';
import { roleHasCommandeFournisseurCapability } from '../../commande-fournisseur/domain/commande-fournisseur-rbac';

export async function prepareGroupedReceipt(body:PrepareGroupedReceipt,audit:AuditContext){
  return consumableCommand({},'RECEIPT_PREPARE',body,audit,async tx=>{
    const supplier=(await tx.query('SELECT id FROM public.fournisseurs WHERE id=$1::uuid',[body.supplierId])).rows[0];
    if(!supplier)throw new HttpError(422,'RECEIPT_SUPPLIER_REQUIRED','Fournisseur introuvable.');
    const receipt=await repoCreateReception({fournisseur_id:body.supplierId,supplier_reference:body.reference,reception_date:body.date},audit,tx);
    await tx.query("UPDATE public.receptions_fournisseurs SET confirmation_state='DRAFT' WHERE id=$1::uuid",[receipt.id]);
    return {id:receipt.id,number:receipt.reception_no,state:'DRAFT' as const};
  });
}

async function assertDeliveryNoteTx(tx:PoolClient,receiptId:string){
  const docs=(await tx.query<{id:string;storage_path:string;sha256:string;size_bytes:number}>(`SELECT id::text,storage_path,sha256,size_bytes FROM public.reception_fournisseur_documents
    WHERE reception_id=$1::uuid AND removed_at IS NULL AND document_type='BON_LIVRAISON' FOR SHARE`,[receiptId])).rows;
  if(!docs.length)throw new HttpError(422,'RECEIPT_DELIVERY_NOTE_REQUIRED','Ajoutez au moins une photo ou un document BL avant de valider la réception.');
  for(const doc of docs){
    const file=resolveCerpStoragePath(doc.storage_path,getDocumentStoragePath('receptions'));
    let content:Buffer;
    try{content=await fs.readFile(file);}catch{throw new HttpError(409,'RECEIPT_DELIVERY_NOTE_UNAVAILABLE','Le BL n’est pas enregistré correctement. Importez-le à nouveau avant validation.');}
    if(content.byteLength!==Number(doc.size_bytes)||!doc.sha256||createHash('sha256').update(content).digest('hex')!==doc.sha256)
      throw new HttpError(409,'RECEIPT_DELIVERY_NOTE_CHANGED','L’intégrité du BL ne peut pas être confirmée. Importez-le à nouveau.');
  }
  return docs.map(d=>d.id);
}

export async function confirmGroupedReceipt(receiptId:string,body:ConfirmGroupedReceipt,audit:AuditContext){
  const actionBody={...body,receiptId};
  return consumableCommand({},'RECEIPT_CONFIRM',actionBody,audit,async tx=>{
    const lineIds=body.lines.map(l=>l.lineId);
    // Lock recipients before supplier orders and physical stock, matching OF preparation.
    await tx.query(`SELECT id FROM public.ordres_fabrication WHERE id IN(SELECT besoin_of_id FROM public.commande_fournisseur_ligne_besoin WHERE ligne_id=ANY($1::uuid[]) AND NOT annule) ORDER BY id FOR UPDATE`,[lineIds]);
    await lockFutureMaterialSupplyTx(tx,lineIds);
    const receipt=(await tx.query<{id:string;number:string;supplierId:string;state:string|null;status:string}>(`SELECT id::text,reception_no AS number,fournisseur_id::text AS "supplierId",confirmation_state AS state,status FROM public.receptions_fournisseurs WHERE id=$1::uuid FOR UPDATE`,[receiptId])).rows[0];
    if(!receipt)throw new HttpError(404,'RECEIPT_NOT_FOUND','Réception introuvable.');
    if(receipt.state!=='DRAFT'||receipt.status!=='OPEN')throw new HttpError(409,'RECEIPT_ALREADY_CONFIRMED','Cette réception est déjà validée ou annulée. Relisez son résultat avant de saisir une nouvelle livraison.');
    if((await tx.query('SELECT 1 FROM public.reception_fournisseur_lignes WHERE reception_id=$1::uuid LIMIT 1',[receiptId])).rows.length)
      throw new HttpError(409,'RECEIPT_DRAFT_HAS_LINES','Ce brouillon contient déjà des lignes officielles. Faites vérifier la réception.');
    const documentIds=await assertDeliveryNoteTx(tx,receiptId);
    const current=await readExpectedReceiptLinesTx(tx,{page:1,pageSize:100},lineIds);
    const actor=(await tx.query<{role:string}>('SELECT role FROM public.users WHERE id=$1',[audit.user_id])).rows[0];
    for(const choice of body.lines){
      const line=current.items.find(i=>i.id===choice.lineId);
      if(!line||line.supplierId!==receipt.supplierId)throw new HttpError(422,'RECEIPT_SUPPLIER_MISMATCH','Les lignes sélectionnées doivent appartenir au fournisseur de ce BL.');
      if(line.version!==choice.expectedVersion)throw new HttpError(409,'RECEIPT_LINE_CHANGED','Une quantité, une condition ou un achat a changé. Relisez le reste à recevoir.');
      if(!line.articleId||!line.unit||!line.stockUnit)throw new HttpError(422,'RECEIPT_ARTICLE_REQUIRED','Complétez l’article et les unités de la ligne de commande avant réception.');
      if(choice.quantity>line.remaining+0.000001&&(!roleHasCommandeFournisseurCapability(actor?.role,'over_receipt')||!choice.overReceiptReason||choice.overReceiptReason.length<3))
        throw new HttpError(403,'RECEIPT_OVER_DELIVERY_FORBIDDEN','Une sur-réception exige l’autorisation dédiée et une justification.');
      if(line.stockManaged&&!choice.destination)throw new HttpError(422,'RECEIPT_DESTINATION_REQUIRED','Confirmez le magasin et l’emplacement de réception.');
      if(line.consumptionMode==='GLOBAL_PACK'&&!choice.packs.length)throw new HttpError(422,'RECEIPT_PACKS_REQUIRED','Identifiez séparément chaque palette ou conditionnement reçu.');
      if(choice.destination){
        const valid=(await tx.query('SELECT id FROM public.emplacements WHERE id=$1 AND magasin_id=$2::uuid',[choice.destination.emplacementId,choice.destination.magasinId])).rows[0];
        if(!valid)throw new HttpError(422,'RECEIPT_DESTINATION_INVALID','Cet emplacement n’appartient pas au magasin choisi.');
      }
    }
    const results:Array<{orderLineId:string;receiptLineId:string;quantity:number;lotId:string|null;lotCode:string|null;state:'STOCKED'|'QUALITY_PENDING'|'ACCEPTED_OFF_STOCK'}>=[];
    for(const choice of body.lines){
      const expected=current.items.find(i=>i.id===choice.lineId)!;
      const portions=choice.packs.length?choice.packs:[{quantity:choice.quantity,supplierLotCode:choice.supplierLotCode}];
      for(const [index,portion] of portions.entries()){
        const created=await repoCreateLine(receiptId,{article_id:expected.articleId!,designation:expected.designation,qty_received:portion.quantity,unite:expected.unit,
          supplier_lot_code:portion.supplierLotCode,commande_fournisseur_ligne_id:choice.lineId,notes:choice.overReceiptReason},audit,{client:tx,batchConfirmation:true});
        if(!created)throw new HttpError(409,'RECEIPT_LINE_NOT_CREATED','La ligne reçue n’a pas pu être enregistrée.');
        if(choice.destination)await tx.query('UPDATE public.reception_fournisseur_lignes SET destination_magasin_id=$2::uuid,destination_emplacement_id=$3 WHERE id=$1::uuid',[created.id,choice.destination.magasinId,choice.destination.emplacementId]);
        let lotId:string|null=null,lotCode:string|null=null;
        if(expected.stockManaged||expected.qualityRequired||expected.lotTracking){
          const lot=await repoCreateLotForLine(receiptId,created.id,{supplier_lot_code:portion.supplierLotCode},audit,tx);
          if(!lot?.lot_id)throw new HttpError(409,'RECEIPT_LOT_NOT_CREATED','Le lot reçu n’a pas pu être identifié.');
          lotId=lot.lot_id;lotCode=lot.lot_code;
          if(expected.consumptionMode==='GLOBAL_PACK')await tx.query('UPDATE public.lots SET is_consumable_pack=true WHERE id=$1::uuid',[lotId]);
          if(!expected.qualityRequired){
            await tx.query(`INSERT INTO public.consumable_receipt_admissions(receipt_line_id,lot_id,quantity,unit,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5)`,[created.id,lotId,portion.quantity*expected.coefficient,expected.stockUnit,audit.user_id]);
            await tx.query("UPDATE public.lots SET lot_status='LIBERE',lot_status_note='Admission directe selon la politique de réception figée sur la commande.',updated_at=now() WHERE id=$1::uuid",[lotId]);
          }
        }
        if(expected.stockManaged&&!expected.qualityRequired){
          const installed=await lockMaterialReceiptRecipientsTx(tx,created.id);
          const posted=await repoCreateStockReceiptLocked(tx,installed,receiptId,created.id,{qty:portion.quantity,dst_magasin_id:choice.destination!.magasinId,dst_emplacement_id:choice.destination!.emplacementId,
            unite:expected.unit!,notes:`Réception ${receipt.number} · BL confirmé`},audit,`${body.idempotencyKey}:${choice.lineId}:${index}`);
          if(!posted)throw new HttpError(409,'RECEIPT_STOCK_NOT_POSTED','L’entrée en stock n’a pas pu être enregistrée.');
        }
        results.push({orderLineId:choice.lineId,receiptLineId:created.id,quantity:portion.quantity,lotId,lotCode,state:expected.qualityRequired?'QUALITY_PENDING':expected.stockManaged?'STOCKED':'ACCEPTED_OFF_STOCK'});
      }
    }
    await tx.query("UPDATE public.receptions_fournisseurs SET confirmation_state='CONFIRMED',confirmation_key=$2::uuid,confirmed_at=now(),confirmed_by=$3,updated_at=now(),updated_by=$3 WHERE id=$1::uuid",[receiptId,body.idempotencyKey,audit.user_id]);
    const surplus=await readOffStockSurplusTx(tx,results.filter(r=>!current.items.find(l=>l.id===r.orderLineId)!.stockManaged).map(r=>r.receiptLineId));
    return {id:receiptId,number:receipt.number,state:'CONFIRMED' as const,documentIds,lines:results.map(r=>({...r,unallocatedOffStock:surplus.get(r.receiptLineId)??null}))};
  });
}
