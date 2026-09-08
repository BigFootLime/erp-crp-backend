import crypto from 'node:crypto';
import type {PoolClient} from 'pg';
import db from '../../../config/database';
import {HttpError} from '../../../utils/httpError';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {enqueueEntityChanged} from '../../../shared/realtime/realtime-outbox.service';
import {roleHasCommandeFournisseurCapability} from '../domain/commande-fournisseur-rbac';
import {assertSelectableSupplierOffer,compareSupplierOffer,consultationSnapshotKey,supplierConsultationRequest,type ConsultationSnapshot,type ConsultationRequestedLine} from '../domain/supplier-consultation';
import {supplierOfferResponseSchema,type SupplierConsultationCommand,type SupplierOfferResponse} from '../validators/supplier-consultation.validators';
import {assertDraft,assertFournisseurCommandable,assertOptimisticToken,fetchFournisseurMini,insertAuditLog,lockHeader,recomputeTotauxTx,type AuditContext} from './commande-fournisseur.repository';
import {readConsultationDocuments,type ConsultationDocument} from './consultation-documents.repository';

type Queryer=Pick<PoolClient,'query'>;
type Round={id:string;round_no:number;status:'OPEN'|'SELECTED'|'CLOSED';source_revision:string;snapshot:ConsultationSnapshot;row_version:number;notes:string;selected_offer_id:string|null;selection_reason:string|null;decided_at:string|null;created_at:string};

function assertAccess(audit:Pick<AuditContext,'role'>,write=false){
  if(!roleHasCommandeFournisseurCapability(audit.role,'prices')||!roleHasCommandeFournisseurCapability(audit.role,write?'update_draft':'read'))
    throw new HttpError(403,'FORBIDDEN','Votre rôle ne permet pas de consulter ou modifier les offres fournisseur.');
}
async function enabled(tx:Queryer){
  return (await tx.query(`SELECT to_regclass('public.supplier_consultations') IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW' AND enabled) AS enabled`)).rows[0]?.enabled===true;
}
async function snapshotTx(tx:Queryer,commandeId:string):Promise<ConsultationSnapshot>{
  const header=(await tx.query(`SELECT code,devise AS currency,adresse_livraison_texte AS delivery_address,
    magasin_livraison_id::text AS destination_id,tva_frais_pct::float8 AS freight_vat_pct FROM public.commande_fournisseur WHERE id=$1::uuid`,[commandeId])).rows[0];
  const lines=(await tx.query<ConsultationRequestedLine>(`SELECT l.id::text,l.designation,l.article_id::text,a.code AS article_code,
    l.quantite::float8 AS quantity,l.unite AS unit,l.unite_stock AS stock_unit,l.coef_conversion::float8 AS coefficient,
    l.tva_pct::float8 AS vat_pct,COALESCE(l.date_besoin,cf.date_besoin)::text AS need_date,l.exigences_qualite AS requirements,l.documents_attendus AS documents,
    l.operation_libelle AS operation,l.of_id FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur cf ON cf.id=l.commande_id LEFT JOIN public.articles a ON a.id=l.article_id
    WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' ORDER BY l.position,l.id`,[commandeId])).rows;
  if(!lines.length||lines.length>200)throw new HttpError(409,'CONSULTATION_LINES_REQUIRED','Préparez entre une et 200 lignes avant de consulter les fournisseurs.');
  if(lines.some(l=>!l.unit?.trim()))throw new HttpError(409,'CONSULTATION_UNIT_REQUIRED','Complétez l’unité de chaque ligne avant la consultation.');
  return {...header,lines};
}
async function assertFrozenSourceTx(tx:Queryer,commandeId:string,round:Round,currentRevision:string){
  if(round.source_revision!==currentRevision)throw new HttpError(409,'CONSULTATION_OBSOLETE','Le brouillon a changé depuis la consultation. Clôturez cette consultation et préparez une nouvelle demande. Les offres enregistrées restent consultables.');
  // Legacy line writers must not allow a stale offer even if an old route did
  // not touch the header's revision token.
  if(consultationSnapshotKey(await snapshotTx(tx,commandeId))!==consultationSnapshotKey(round.snapshot))throw new HttpError(409,'CONSULTATION_OBSOLETE','Les lignes ou exigences ont changé. Préparez une nouvelle consultation.');
}
async function roundTx(tx:Queryer,commandeId:string,id:string){
  const r=(await tx.query<Round>(`SELECT *,decided_at::text,created_at::text FROM public.supplier_consultations WHERE id=$1::uuid AND commande_id=$2::uuid FOR UPDATE`,[id,commandeId])).rows[0];
  if(!r)throw new HttpError(404,'CONSULTATION_NOT_FOUND','Consultation introuvable.');
  return r;
}

export async function repoReadSupplierConsultations(commandeId:string,role:string|null|undefined,roundId?:string,actorId=0){
  assertAccess({role});
  const header=(await db.query(`SELECT statut,updated_at::text AS revision FROM public.commande_fournisseur WHERE id=$1::uuid`,[commandeId])).rows[0];
  if(!header)throw new HttpError(404,'COMMANDE_FOURNISSEUR_NOT_FOUND','Commande fournisseur introuvable.');
  if(!await enabled(db))return {enabled:false,rounds:[],current:null,headerRevision:header.revision};
  const rounds=(await db.query<{id:string;round_no:number;status:string;created_at:string}>(`SELECT id::text,round_no,status,created_at::text FROM public.supplier_consultations WHERE commande_id=$1::uuid ORDER BY round_no DESC`,[commandeId])).rows;
  const selected=roundId??rounds[0]?.id;
  if(!selected)return {enabled:true,rounds,current:null,headerRevision:header.revision};
  const current=(await db.query<Round>(`SELECT *,decided_at::text,created_at::text FROM public.supplier_consultations WHERE id=$1::uuid AND commande_id=$2::uuid`,[selected,commandeId])).rows[0];
  if(!current)throw new HttpError(404,'CONSULTATION_NOT_FOUND','Consultation introuvable.');
  const invitations=(await db.query<{id:string;supplier_id:string;supplier_name:string;request_text:string;created_at:string;documents:ConsultationDocument[]}>(`SELECT i.id::text,i.supplier_id::text,COALESCE(f.nom,f.raison_sociale) AS supplier_name,i.request_text,i.documents,i.created_at::text
    FROM public.supplier_consultation_invitations i JOIN public.fournisseurs f ON f.id=i.supplier_id WHERE i.consultation_id=$1::uuid ORDER BY i.created_at,i.id`,[current.id])).rows;
  const offers=(await db.query<{id:string;invitation_id:string;revision:number;response:SupplierOfferResponse;correction_reason:string|null;created_at:string;is_latest:boolean}>(`SELECT o.id::text,o.invitation_id::text,o.revision,o.response,o.correction_reason,o.created_at::text,
    NOT EXISTS(SELECT 1 FROM public.supplier_consultation_offers newer WHERE newer.invitation_id=o.invitation_id AND newer.revision>o.revision) AS is_latest
    FROM public.supplier_consultation_offers o JOIN public.supplier_consultation_invitations i ON i.id=o.invitation_id WHERE i.consultation_id=$1::uuid ORDER BY o.created_at,o.id`,[current.id])).rows;
  const today=(await db.query<{today:string}>('SELECT CURRENT_DATE::text AS today')).rows[0].today;
  const availableDocuments=current.status==='OPEN'?await readConsultationDocuments(db,commandeId,{user_id:actorId,role}):[];
  return {enabled:true,rounds,headerRevision:header.revision,availableDocuments,current:{...current,obsolete:current.status==='OPEN'&&(current.source_revision!==header.revision||header.statut!=='BROUILLON'),invitations,
    offers:offers.map(o=>({...o,comparison:compareSupplierOffer(current.snapshot,supplierOfferResponseSchema.parse(o.response),today)}))}};
}

/** One canonical draft, a durable command receipt, and append-only offer history.
 * Lock order starts at planning, as coverage/receipt paths do, then the PO. No
 * stock balance or allocation is changed when choosing an offer. */
export async function repoCommandSupplierConsultation(commandeId:string,body:SupplierConsultationCommand,audit:AuditContext){
  assertAccess(audit,true);
  return withRealtimeOutboxTransaction(await db.connect(),async tx=>{
    if(!await enabled(tx))throw new HttpError(409,'CONSULTATION_DISABLED','Le parcours de consultation n’est pas activé sur cette base.');
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`supplier-consultation:${audit.user_id}:${body.idempotency_key}`]);
    const requestHash=crypto.createHash('sha256').update(JSON.stringify({commandeId,body})).digest('hex');
    const prior=(await tx.query<{request_hash:string;result:{consultationId:string;action:string;offerId?:string}}>(`SELECT request_hash,result FROM public.supplier_consultation_commands WHERE actor_id=$1 AND command_key=$2`,[audit.user_id,body.idempotency_key])).rows[0];
    if(prior){
      if(prior.request_hash!==requestHash)throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED','Cette action a déjà été utilisée avec un autre contenu.');
      return prior.result;
    }
    const header=await lockHeader(tx,commandeId);
    assertOptimisticToken(body.expected_updated_at,header.updated_at_token);
    const today=(await tx.query<{today:string}>('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    let consultationId:string;
    let offerId:string|undefined;
    if(body.action==='OPEN'){
      assertDraft(header.statut);
      const open=(await tx.query(`SELECT id FROM public.supplier_consultations WHERE commande_id=$1::uuid AND status='OPEN'`,[commandeId])).rows[0];
      if(open)throw new HttpError(409,'CONSULTATION_ALREADY_OPEN','Une consultation est déjà ouverte pour ce brouillon.');
      const snapshot=await snapshotTx(tx,commandeId);
      consultationId=(await tx.query<{id:string}>(`INSERT INTO public.supplier_consultations(commande_id,round_no,source_revision,snapshot,notes,created_by)
        SELECT $1::uuid,COALESCE(max(round_no),0)+1,$2,$3::jsonb,$4,$5 FROM public.supplier_consultations WHERE commande_id=$1::uuid RETURNING id::text`,
        [commandeId,header.updated_at_token,JSON.stringify(snapshot),body.notes,audit.user_id])).rows[0].id;
    }else{
      const round=await roundTx(tx,commandeId,body.consultation_id);
      consultationId=round.id;
      if(round.row_version!==body.expected_version)throw new HttpError(409,'CONSULTATION_CHANGED','Une autre personne a modifié cette consultation. Actualisez avant de confirmer.');
      if(round.status!=='OPEN')throw new HttpError(409,'CONSULTATION_CLOSED','Cette consultation est clôturée ; son historique reste consultable.');
      if(body.action==='CLOSE'){
        await tx.query(`UPDATE public.supplier_consultations SET status='CLOSED',selection_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1::uuid`,[round.id,body.reason,audit.user_id]);
      }else{
        assertDraft(header.statut);
        if(body.action==='INVITE'){
          await assertFrozenSourceTx(tx,commandeId,round,header.updated_at_token);
          const supplier=await fetchFournisseurMini(tx,body.supplier_id);
          assertFournisseurCommandable(supplier);
          const invited=(await tx.query<{supplier_id:string}>(`SELECT supplier_id::text FROM public.supplier_consultation_invitations WHERE consultation_id=$1::uuid`,[round.id])).rows;
          if(invited.some(i=>i.supplier_id===body.supplier_id))throw new HttpError(409,'SUPPLIER_ALREADY_INVITED','La demande de ce fournisseur est déjà préparée.');
          if(invited.length>=20)throw new HttpError(409,'CONSULTATION_SUPPLIER_LIMIT','Une consultation peut comparer au maximum 20 fournisseurs.');
          const documents=await readConsultationDocuments(tx,commandeId,audit,body.document_version_ids??[]);
          const request=supplierConsultationRequest(round.snapshot,supplier.nom??' ',round.notes)+
            (documents.length?'\n\nPièces jointes sélectionnées :\n'+documents.map(d=>`${d.code} · ${d.title} · version ${d.version_number} · ${d.original_name}`).join('\n'):'');
          await tx.query(`INSERT INTO public.supplier_consultation_invitations(consultation_id,supplier_id,request_text,created_by,documents) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb)`,
            [round.id,body.supplier_id,request,audit.user_id,JSON.stringify(documents)]);
        }else if(body.action==='RECORD_OFFER'){
          const invitation=(await tx.query(`SELECT id FROM public.supplier_consultation_invitations WHERE id=$1::uuid AND consultation_id=$2::uuid`,[body.invitation_id,round.id])).rows[0];
          if(!invitation)throw new HttpError(404,'CONSULTATION_INVITATION_NOT_FOUND','Demande fournisseur introuvable.');
          if(body.response.lines.some(l=>!round.snapshot.lines.some(n=>n.id===l.line_id)))throw new HttpError(422,'CONSULTATION_LINE_MISMATCH','Une ligne de l’offre ne correspond pas à cette consultation.');
          const previous=(await tx.query<{revision:number}>(`SELECT COALESCE(max(revision),0)::int AS revision FROM public.supplier_consultation_offers WHERE invitation_id=$1::uuid`,[invitation.id])).rows[0].revision;
          if(previous&&!body.correction_reason)throw new HttpError(422,'OFFER_CORRECTION_REASON_REQUIRED','Précisez le motif de correction ; la réponse précédente restera conservée.');
          if(previous>=50)throw new HttpError(409,'OFFER_REVISION_LIMIT','Clôturez cette consultation avant de préparer une nouvelle demande.');
          offerId=(await tx.query<{id:string}>(`INSERT INTO public.supplier_consultation_offers(invitation_id,revision,response,correction_reason,created_by) VALUES($1::uuid,$2,$3::jsonb,$4,$5) RETURNING id::text`,
            [invitation.id,previous+1,JSON.stringify(body.response),body.correction_reason??null,audit.user_id])).rows[0].id;
        }else if(body.action==='SELECT'){
          await assertFrozenSourceTx(tx,commandeId,round,header.updated_at_token);
          const offer=(await tx.query<{id:string;response:SupplierOfferResponse;supplier_id:string;is_latest:boolean}>(`SELECT o.id::text,o.response,i.supplier_id::text,
            NOT EXISTS(SELECT 1 FROM public.supplier_consultation_offers newer WHERE newer.invitation_id=o.invitation_id AND newer.revision>o.revision) AS is_latest
            FROM public.supplier_consultation_offers o JOIN public.supplier_consultation_invitations i ON i.id=o.invitation_id WHERE o.id=$1::uuid AND i.consultation_id=$2::uuid`,[body.offer_id,round.id])).rows[0];
          if(!offer)throw new HttpError(404,'SUPPLIER_OFFER_NOT_FOUND','Offre introuvable dans cette consultation.');
          if(!offer.is_latest)throw new HttpError(409,'SUPPLIER_OFFER_SUPERSEDED','Une réponse plus récente existe pour ce fournisseur.');
          assertFournisseurCommandable(await fetchFournisseurMini(tx,offer.supplier_id));
          const response=supplierOfferResponseSchema.parse(offer.response);
          assertSelectableSupplierOffer(round.snapshot,response,today);
          for(const line of response.lines){
            const update=await tx.query(`UPDATE public.commande_fournisseur_ligne SET quantite=$3,prix_unitaire_ht=$4,remise_pct=$5,frais_ht=$6,
              reference_fournisseur=$7,catalogue_id=NULL,delai_jours=NULL,updated_at=now(),updated_by=$8
              WHERE id=$1::uuid AND commande_id=$2::uuid AND statut_ligne='ACTIVE'`,
              [line.line_id,commandeId,line.quantity,line.unit_price_ht,line.discount_pct,line.fees_ht,line.supplier_reference||null,audit.user_id]);
            if(update.rowCount!==1)throw new HttpError(409,'CONSULTATION_OBSOLETE','Une ligne a changé ; aucune partie de l’offre n’a été appliquée.');
          }
          await tx.query(`UPDATE public.commande_fournisseur SET fournisseur_id=$2::uuid,devise=$3,frais_port_ht=$4,conditions_paiement=$5,
            contact_id=CASE WHEN fournisseur_id=$2::uuid THEN contact_id ELSE NULL END,
            adresse_commande_id=CASE WHEN fournisseur_id=$2::uuid THEN adresse_commande_id ELSE NULL END,
            fournisseur_snapshot=NULL,conditions_snapshot=NULL,updated_at=now(),updated_by=$6 WHERE id=$1::uuid`,
            [commandeId,offer.supplier_id,response.currency,response.freight_ht,response.payment_terms||null,audit.user_id]);
          await recomputeTotauxTx(tx,commandeId);
          await tx.query(`UPDATE public.supplier_consultations SET status='SELECTED',selected_offer_id=$2::uuid,selection_reason=$3,decided_by=$4,decided_at=now() WHERE id=$1::uuid`,[round.id,offer.id,body.reason,audit.user_id]);
          offerId=offer.id;
          const recipients=(await tx.query<{of_id:number}>(`SELECT DISTINCT b.of_id FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id WHERE l.commande_id=$1::uuid AND NOT b.annule AND b.of_id IS NOT NULL`,[commandeId])).rows;
          for(const recipient of recipients)await enqueueEntityChanged(tx,{entityType:'OF',entityId:String(recipient.of_id),module:'production',action:'updated',at:new Date().toISOString(),invalidateKeys:[`production:of:${recipient.of_id}`]},
            {deduplicationKey:`supplier-offer:${round.id}:${offer.id}:of:${recipient.of_id}`});
        }
      }
      await tx.query('UPDATE public.supplier_consultations SET row_version=row_version+1,updated_at=now() WHERE id=$1::uuid',[round.id]);
    }
    const result={consultationId,action:body.action,...(offerId?{offerId}:{})};
    await insertAuditLog(tx,audit,{action:`commandes_fournisseurs.consultation.${body.action.toLowerCase()}`,entity_type:'commande_fournisseur',entity_id:commandeId,details:{...result,request:body}});
    await tx.query(`INSERT INTO public.supplier_consultation_commands(actor_id,command_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)`,[audit.user_id,body.idempotency_key,requestHash,JSON.stringify(result)]);
    await enqueueEntityChanged(tx,{entityType:'COMMANDE_FOURNISSEUR',entityId:commandeId,module:'commandes-fournisseurs',action:'updated',at:new Date().toISOString(),invalidateKeys:[`achats:detail:${commandeId}`]},
      {deduplicationKey:`supplier-consultation:${audit.user_id}:${body.idempotency_key}`});
    return result;
  });
}
