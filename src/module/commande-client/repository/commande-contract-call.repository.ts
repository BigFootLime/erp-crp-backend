import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {repoInsertAuditLog} from '../../audit-logs/repository/audit-logs.repository';
import {enqueueEntityChanged} from '../../../shared/realtime/realtime-outbox.service';
import {readCrmClient} from '../../client/repository/client-crm.repository';
import {readClientContract} from '../../client/repository/client-contract.repository';
import type {ClientContract,ClientContractArticle,ClientContractLine} from '../../client/types/client-contract.types';
import type {CreateCommandeInput,UploadedDocument} from '../types/commande-client.types';
import {assertLegacyContractOrderMutable,assertNoLegacyContractAssociation} from './commande-contract-legacy-guards.repository';
type Queryer=Pick<PoolClient,'query'>;
type SelectedLine={contractLine:ClientContractLine;article:ClientContractArticle;index:number};
export type ContractCallContext={id:string;contract:ClientContract;actor:number;key:string;hash:string;lines:SelectedLine[]};

/** Caught only after the upload transaction confirms rollback and cleans this retry's fresh files. */
export class ContractCallReplay extends Error {
  constructor(readonly commandeId:number){super('CONTRACT_CALL_REPLAY');}
}
async function documentDigest(document:UploadedDocument) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(document.path))hash.update(chunk);
  return {name:document.originalname,mime:document.mimetype,sha256:hash.digest('hex')};
}
function realDate(value:string|undefined|null) {
  if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
const sameId=(left:string|null|undefined,right:string)=>left?.toLowerCase()===right.toLowerCase();
export async function prepareContractCall(tx:Queryer,input:CreateCommandeInput,actor:number|null,documents:UploadedDocument[]):Promise<ContractCallContext|null> {
  if(input.order_type==='CADRE')throw new HttpError(409,'CLIENT_MASTER_CONTRACT_REQUIRED','Définissez le contrat dans la fiche client, puis créez un appel de commande ferme');
  const request=input.client_contract_call;
  if(!request) {
    if(input.lignes.some(line=>line.client_contract_line_id))throw new HttpError(422,'CONTRACT_CALL_REQUIRED','Choisissez le contrat de ces articles');
    return null;
  }
  if(!actor||!input.client_id||(input.order_type??'FERME')!=='FERME')
    throw new HttpError(422,'CONTRACT_CALL_FIRM_REQUIRED','Un appel de contrat exige une commande ferme et son client');
  const files=[];
  for(const document of documents)files.push(await documentDigest(document));
  const hash=createHash('sha256').update(JSON.stringify({input,files})).digest('hex');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contract-call:${actor}:${request.idempotency_key}`]);
  const replay=(await tx.query<{request_hash:string;commande_id:string}>(`SELECT request_hash,commande_id::text
    FROM public.client_contract_calls WHERE actor_user_id=$1 AND idempotency_key=$2::uuid`,[actor,request.idempotency_key])).rows[0];
  if(replay) {
    if(replay.request_hash!==hash)throw new HttpError(409,'CONTRACT_CALL_KEY_CONFLICT','Cette tentative correspond à une autre commande');
    const id=Number(replay.commande_id);
    if(!Number.isSafeInteger(id)||id<=0)throw new Error('UNSAFE_CONTRACT_CALL_ORDER_ID');
    throw new ContractCallReplay(id);
  }
  const client=await readCrmClient(tx,input.client_id,true);
  if(!client||client.archived_at||client.blocked||client.status==='inactif')throw new HttpError(409,'CONTRACT_CALL_CLIENT_INACTIVE','Le client est inactif ou bloqué');
  const contract=await readClientContract(tx,input.client_id,request.contract_id,true);
  if(!contract)throw new HttpError(404,'CONTRACT_CALL_NOT_FOUND','Contrat introuvable pour ce client');
  if(contract.version!==request.expected_version)throw new HttpError(409,'CONTRACT_CALL_VERSION_CONFLICT','Le contrat a changé. Actualisez les articles proposés.');
  if(contract.status!=='ACTIVE')throw new HttpError(409,'CONTRACT_CALL_INACTIVE','Le contrat doit être actif');
  if(!realDate(input.date_commande)||(contract.valid_from&&input.date_commande!<contract.valid_from)
    ||(contract.valid_until&&input.date_commande!>contract.valid_until))throw new HttpError(422,'CONTRACT_CALL_DATE_INVALID','La date de commande doit être comprise dans la période du contrat');
  const used=new Set<string>();
  const lines=input.lignes.map((line,index)=>{
    const contractLine=contract.lines.find(item=>item.id===line.client_contract_line_id);
    const article=contractLine?.proposed_article;
    if(!contractLine||!article||used.has(contractLine.id))throw new HttpError(422,'CONTRACT_CALL_LINE_INVALID','Chaque ligne doit sélectionner un article disponible du contrat, une seule fois',{field:`lignes.${index}.article_id`});
    used.add(contractLine.id);
    if(!sameId(line.article_id,article.article_id)||!sameId(line.piece_technique_id,article.piece_technique_id)
      ||!sameId(line.piece_technique_version_id,article.piece_technique_version_id)||line.unite?.toLowerCase()!==article.unit.toLowerCase())
      throw new HttpError(409,'CONTRACT_CALL_ARTICLE_CHANGED','L’article, son indice ou son unité a changé. Actualisez le contrat.',{field:`lignes.${index}.article_id`});
    if(line.id||line.source_devis_ligne_id||line.source_article_devis_id||line.source_dossier_devis_id||line.technical_draft)
      throw new HttpError(422,'CONTRACT_CALL_PREPARATORY_DATA','Un appel utilise les articles validés du contrat');
    if(!realDate(line.delai_client)||!Number.isFinite(line.quantite)||line.quantite<=0||line.quantite>1_000_000_000||Number(line.quantite.toFixed(3))!==line.quantite)
      throw new HttpError(422,'CONTRACT_CALL_QUANTITY_DATE','Quantité ou délai client invalide',{field:`lignes.${index}.quantite`});
    return {contractLine,article,index};
  });
  return {id:randomUUID(),contract,actor,key:request.idempotency_key,hash,lines};
}
export async function recordContractCall(tx:Queryer,context:ContractCallContext|null,commandeId:string,input:CreateCommandeInput) {
  if(!context)return;
  await tx.query(`INSERT INTO public.client_contract_calls(id,contract_id,client_id,commande_id,contract_version,
    contract_snapshot,actor_user_id,idempotency_key,request_hash,customer_reference,order_date)
    VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7,$8::uuid,$9,$10,$11::date)`,
  [context.id,context.contract.id,context.contract.client_id,commandeId,context.contract.version,JSON.stringify(context.contract),
    context.actor,context.key,context.hash,input.code_client,input.date_commande]);
  const saved=(await tx.query<{id:string;article_id:string;piece_technique_version_id:string}>(`SELECT id::text,article_id::text,piece_technique_version_id::text
    FROM public.commande_ligne WHERE commande_id=$1::bigint ORDER BY id`,[commandeId])).rows;
  if(saved.length!==context.lines.length)throw new Error('CONTRACT_CALL_LINE_COUNT_MISMATCH');
  for(const selected of context.lines) {
    const row=saved[selected.index],line=input.lignes[selected.index];
    if(row.article_id!==selected.article.article_id||row.piece_technique_version_id!==selected.article.piece_technique_version_id)
      throw new Error('CONTRACT_CALL_CANONICAL_LINE_MISMATCH');
    await tx.query(`INSERT INTO public.client_contract_call_lines(call_id,contract_id,contract_line_id,commande_ligne_id,article_id,
      piece_technique_version_id,unit_id,initial_qty,initial_due_date,article_snapshot,replenishment_qty)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::uuid,$7::uuid,$8,$9::date,$10::jsonb,$11)`,
    [context.id,context.contract.id,selected.contractLine.id,row.id,selected.article.article_id,selected.article.piece_technique_version_id,
      selected.article.unit_id,line.quantite,line.delai_client,JSON.stringify(selected.article),selected.contractLine.replenishment_qty]);
  }
  await repoInsertAuditLog({tx,user_id:context.actor,ip:null,user_agent:null,device_type:null,os:null,browser:null,
    body:{event_type:'ACTION',action:'CLIENT_CONTRACT_CALL_CREATED',entity_type:'commande-client',entity_id:commandeId,
      page_key:'commandes.client-contract-call',details:{call_id:context.id,contract_id:context.contract.id,contract_version:context.contract.version}}});
  const at=new Date().toISOString();
  await enqueueEntityChanged(tx,{module:'clients',entityType:'CLIENT',entityId:context.contract.client_id,action:'updated',at,
    invalidateKeys:[`client:${context.contract.client_id}`]},{deduplicationKey:`contract-call:${context.id}:client`});
  await enqueueEntityChanged(tx,{module:'commandes',entityType:'COMMANDE_CLIENT',entityId:commandeId,action:'created',at,
    invalidateKeys:['commandes:list',`commandes:detail:${commandeId}`]},{deduplicationKey:`contract-call:${context.id}:order`});
}
export async function assertContractCallMutable(tx:Queryer,commandeId:string,input:CreateCommandeInput) {
  const call=(await tx.query<{contract_id:string;client_id:string}>(`SELECT contract_id::text,client_id FROM public.client_contract_calls
    WHERE commande_id=$1::bigint`,[commandeId])).rows[0];
  if(!call) {
    if(input.client_contract_call||input.lignes.some(line=>line.client_contract_line_id))throw new HttpError(409,'CONTRACT_CALL_REBIND_FORBIDDEN','Créez un nouvel appel depuis le contrat');
    await assertLegacyContractOrderMutable(tx,commandeId,input);
    return;
  }
  if(input.client_id!==call.client_id||(input.order_type??'FERME')!=='FERME'
    ||(input.client_contract_call&&input.client_contract_call.contract_id!==call.contract_id))
    throw new HttpError(409,'CONTRACT_CALL_IDENTITY_IMMUTABLE','Le client et le contrat d’un appel enregistré sont conservés');
  const rows=(await tx.query<{commande_ligne_id:string;article_id:string;piece_technique_id:string;piece_technique_version_id:string;unit:string}>(`SELECT binding.commande_ligne_id::text,
    binding.article_id::text,binding.article_snapshot->>'piece_technique_id' AS piece_technique_id,binding.piece_technique_version_id::text,unit.code AS unit FROM public.client_contract_call_lines binding
    JOIN public.client_contract_calls call ON call.id=binding.call_id JOIN public.units unit ON unit.id=binding.unit_id WHERE call.commande_id=$1::bigint`,[commandeId])).rows;
  if(rows.length!==input.lignes.length||rows.some(row=>!input.lignes.some(line=>String(line.id)===row.commande_ligne_id
    &&sameId(line.article_id,row.article_id)&&sameId(line.piece_technique_id,row.piece_technique_id)&&sameId(line.piece_technique_version_id,row.piece_technique_version_id)&&line.unite?.toLowerCase()===row.unit.toLowerCase())))
    throw new HttpError(409,'CONTRACT_CALL_LINES_IMMUTABLE','Les articles et indices de cet appel sont conservés. Créez un nouvel appel pour changer sa composition.');
}
export async function assertNoContractCall(tx:Queryer,commandeId:number) {
  await assertNoLegacyContractAssociation(tx,commandeId);
  if((await tx.query('SELECT 1 FROM public.client_contract_calls WHERE commande_id=$1::bigint',[commandeId])).rows.length)
    throw new HttpError(409,'CONTRACT_CALL_HISTORY_RETAINED','Cet appel est conservé dans l’historique. Pour une nouvelle demande, créez un appel depuis le contrat.');
}
