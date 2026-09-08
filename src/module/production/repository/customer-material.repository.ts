import {materialCommand,readMaterialTx} from './of-material.repository';
import type {CustomerMaterialCommand} from '../validators/customer-material.validators';
import type {AuditContext} from './production.repository';
import {materialBalance,quantity} from '../domain/of-material';
import {HttpError} from '../../../utils/httpError';
import {createCustomerMaterialReceiptTx} from '../../receptions/repository/receptions.repository';

export async function commandCustomerMaterial(ofId:number,body:CustomerMaterialCommand,audit:AuditContext){
  return materialCommand(ofId,`CUSTOMER_${body.action}`,body,audit,async(tx,current)=>{
    let reception:{receptionId:string;receptionNo:string;lineId:string;lotId:string}|undefined;
    if(body.action==='PREPARE'){
      if(current.previousNeeds?.length)throw new HttpError(409,'CUSTOMER_MATERIAL_RECONCILIATION_REQUIRED','Rapprochez les engagements de la préparation précédente avant un nouvel appel client.');
      const need=current.needs.find(n=>n.key===body.needKey);
      if(!need?.id||need.supplyMode!=='CUSTOMER'||need.blockers.length||!current.clientId||need.requirements.ownerClientId!==current.clientId)
        throw new HttpError(409,'CUSTOMER_MATERIAL_PREPARATION_REQUIRED','Confirmez le besoin, sa règle de débit et le client propriétaire.');
      if(body.quantity>materialBalance(need).missing)throw new HttpError(409,'CUSTOMER_MATERIAL_OVER_COVERAGE','La demande dépasse le manque de matière restant.');
      await tx.query(`INSERT INTO public.of_customer_material_calls(need_id,client_id,quantity,unit,requirements,need_date,note,created_by,updated_by)
        VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6::date,$7,$8,$8)`,[need.id,current.clientId,body.quantity,need.unit,JSON.stringify(need.requirements),body.needDate,body.note,audit.user_id]);
    }else{
      const call=current.customerCalls.find(c=>c.id===body.callId);
      if(!call||call.status==='CANCELLED')throw new HttpError(409,'CUSTOMER_MATERIAL_CALL_UNAVAILABLE','Cet appel client n’est plus actif.');
      await tx.query('SELECT id FROM public.of_customer_material_calls WHERE id=$1::uuid FOR UPDATE',[call.id]);
      if(body.action==='SENT'){
        if(call.status!=='PREPARED')throw new HttpError(409,'CUSTOMER_MATERIAL_ALREADY_SENT','L’envoi de cet appel est déjà enregistré.');
        await tx.query(`UPDATE public.of_customer_material_calls SET status='SENT',sent_reference=$2,sent_at=now() WHERE id=$1::uuid`,[call.id,body.reference]);
      }else if(body.action==='ANNOUNCE'){
        if(call.status==='PREPARED')throw new HttpError(409,'CUSTOMER_MATERIAL_SEND_REQUIRED','Enregistrez la référence de la demande transmise avant la réponse client.');
        await tx.query(`UPDATE public.of_customer_material_calls SET status='ANNOUNCED',announced_date=$2::date WHERE id=$1::uuid`,[call.id,body.date]);
      }else if(body.action==='CANCEL'){
        if(call.received>0)throw new HttpError(409,'CUSTOMER_MATERIAL_RECEIVED','Une réception existe : conservez son appel pour la traçabilité.');
        await tx.query(`UPDATE public.of_customer_material_calls SET status='CANCELLED' WHERE id=$1::uuid`,[call.id]);
      }else{
        if(call.status==='PREPARED')throw new HttpError(409,'CUSTOMER_MATERIAL_SEND_REQUIRED','Enregistrez la référence de la demande transmise avant réception.');
        if(body.quantity>quantity(call.quantity-call.received))throw new HttpError(409,'CUSTOMER_MATERIAL_OVER_RECEIPT','La quantité reçue dépasse le solde de cet appel.');
        const need=current.needs.find(n=>n.id===call.need_id);
        if(!need||need.supplyMode!=='CUSTOMER'||need.requirements.ownerClientId!==call.client_id)
          throw new HttpError(409,'CUSTOMER_MATERIAL_REVISION_CHANGED','Le besoin a changé : rapprochez la révision et le client propriétaire avant réception.');
        reception=await createCustomerMaterialReceiptTx(tx,{callId:call.id,clientId:call.client_id,articleId:need.articleId!,designation:need.designation,quantity:body.quantity,unit:call.unit,date:body.date,reference:body.reference,note:body.note},audit);
      }
      await tx.query('UPDATE public.of_customer_material_calls SET row_version=row_version+1,updated_at=now(),updated_by=$2 WHERE id=$1::uuid',[call.id,audit.user_id]);
    }
    return {coverage:await readMaterialTx(tx,ofId),...(reception?{reception}:{})};
  });
}
