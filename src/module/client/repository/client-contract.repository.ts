import type { PoolClient } from "pg";
import type { ClientContract,ClientContractArticle,ClientContractResult } from "../types/client-contract.types";
import type { ClientContractCommand } from "../validators/client-contract.validators";
type Queryer=Pick<PoolClient,"query">;

// The root identifies the commercial family. Only a validated article and an
// effective APPLICABLE technical version can be proposed for a future call.
const ARTICLE_OPTIONS=`SELECT DISTINCT ON (COALESCE(a.root_article_id,a.id))
  a.id::text AS article_id,COALESCE(a.root_article_id,a.id)::text AS root_article_id,
  a.code,a.designation,a.piece_technique_id::text,av.id::text AS piece_technique_version_id,av.indice,
  unit.id::text AS unit_id,unit.code AS unit
  FROM public.articles a JOIN public.units unit ON unit.code=a.unite
  JOIN LATERAL (SELECT v.id,v.indice,v.date_application,v.created_at FROM public.piece_technique_versions v
    WHERE v.piece_technique_id=a.piece_technique_id AND v.statut='APPLICABLE'
      AND (v.date_application IS NULL OR v.date_application<=CURRENT_DATE)
    ORDER BY v.date_application DESC NULLS LAST,v.version_interne DESC,v.created_at DESC,v.id LIMIT 1) av ON true
  WHERE a.status='VALIDE' AND a.archived_at IS NULL AND a.is_sold
    AND EXISTS(SELECT 1 FROM public.article_client_links acl WHERE acl.article_id=a.id AND acl.client_id=$1)
  ORDER BY COALESCE(a.root_article_id,a.id),av.date_application DESC NULLS LAST,av.created_at DESC,
    a.version_number DESC,a.updated_at DESC,a.id`;

export async function readContractArticleOptions(db:Queryer,clientId:string,q="",roots?:readonly string[]):Promise<ClientContractArticle[]> {
  const {rows}=await db.query<ClientContractArticle>(`SELECT * FROM (${ARTICLE_OPTIONS}) proposed
    WHERE ($2='' OR concat_ws(' ',code,designation,indice) ILIKE '%'||$2||'%')
      AND ($3::uuid[] IS NULL OR root_article_id::uuid=ANY($3::uuid[])) ORDER BY code,article_id LIMIT 200`,
  [clientId,q,roots??null]);
  return rows;
}
const HEADER_FIELDS=`id::text,client_id,reference,title,status,valid_from::text,valid_until::text,version,updated_at::text`;
const HEADER=`SELECT ${HEADER_FIELDS} FROM public.client_contracts`;
export async function readClientContract(db:Queryer,clientId:string,id:string,lock=false):Promise<ClientContract|null> {
  const header=(await db.query<Omit<ClientContract,"lines">>(`${HEADER} WHERE id=$1::uuid AND client_id=$2${lock?" FOR UPDATE":""}`,[id,clientId])).rows[0];
  if(!header)return null;
  const lines=(await db.query<Omit<ClientContract["lines"][number],"proposed_article">>(`SELECT line.id::text,line.article_id::text,
    line.root_article_id::text,line.replenishment_qty::text,line.unit_id::text,unit.code AS unit,
    line.configured_code,line.configured_designation,line.configured_indice,line.configured_piece_technique_version_id::text
    FROM public.client_contract_lines line
    JOIN public.units unit ON unit.id=line.unit_id WHERE line.contract_id=$1::uuid AND line.active
    ORDER BY line.configured_code,line.id`,[id])).rows;
  const proposed=await readContractArticleOptions(db,clientId,"",lines.map(line=>line.root_article_id));
  const byRoot=new Map(proposed.map(article=>[article.root_article_id,article]));
  return {...header,lines:lines.map(line=>{
    const article=byRoot.get(line.root_article_id);
    return {...line,proposed_article:article?.unit_id===line.unit_id?article:null};
  })};
}
export async function listClientContracts(db:Queryer,clientId:string,page:number) {
  const {rows}=await db.query<Omit<ClientContract,"lines"> & {line_count:number}>(`SELECT ${HEADER_FIELDS},
    (SELECT count(*)::int FROM public.client_contract_lines line WHERE line.contract_id=client_contracts.id AND line.active) AS line_count
    FROM public.client_contracts
    WHERE client_id=$1 ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,reference,id LIMIT 25 OFFSET $2`,[clientId,(page-1)*25]);
  const total=(await db.query<{total:number}>("SELECT count(*)::int AS total FROM public.client_contracts WHERE client_id=$1",[clientId])).rows[0].total;
  return {items:rows,total,page,page_size:25};
}
export async function readContractHistory(db:Queryer,clientId:string,id:string,page:number) {
  const {rows}=await db.query(`SELECT event.id::text,event.action,event.reason,event.created_at::text,
    event.actor_user_id,actor.username AS actor_label,event.previous_snapshot,event.result_payload
    FROM public.client_contract_events event JOIN public.users actor ON actor.id=event.actor_user_id
    WHERE event.client_id=$1 AND event.contract_id=$2::uuid ORDER BY event.created_at DESC,event.id DESC LIMIT 25 OFFSET $3`,[clientId,id,(page-1)*25]);
  const total=(await db.query<{total:number}>("SELECT count(*)::int AS total FROM public.client_contract_events WHERE client_id=$1 AND contract_id=$2::uuid",[clientId,id])).rows[0].total;
  return {items:rows,total,page,page_size:25};
}
export async function readContractReplay(db:Queryer,actor:number,key:string) {
  return (await db.query<{request_hash:string;result_payload:ClientContractResult}>(`SELECT request_hash,result_payload
    FROM public.client_contract_events WHERE actor_user_id=$1 AND idempotency_key=$2::uuid`,[actor,key])).rows[0]??null;
}
export async function lockContractArticles(db:Queryer,ids:readonly string[]) {
  return (await db.query<{root_article_id:string}>(`SELECT COALESCE(root_article_id,id)::text AS root_article_id
    FROM public.articles WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,[ids])).rows.map(row=>row.root_article_id);
}
export async function writeClientContract(db:Queryer,clientId:string,id:string,actor:number,
  command:Exclude<ClientContractCommand,{action:"CLOSE"}>,articles:readonly ClientContractArticle[]) {
  if(command.action==="CREATE") {
    await db.query(`INSERT INTO public.client_contracts(id,client_id,reference,title,valid_from,valid_until,status,created_by,updated_by)
      VALUES($1::uuid,$2,$3,$4,$5::date,$6::date,$7,$8,$8)`,[id,clientId,command.reference,command.title,command.valid_from,command.valid_until,command.status,actor]);
  } else {
    await db.query(`UPDATE public.client_contracts SET reference=$3,title=$4,valid_from=$5::date,valid_until=$6::date,
      status=$7,version=version+1,updated_by=$8,updated_at=now() WHERE id=$1::uuid AND client_id=$2`,
    [id,clientId,command.reference,command.title,command.valid_from,command.valid_until,command.status,actor]);
    await db.query("UPDATE public.client_contract_lines SET active=false WHERE contract_id=$1::uuid",[id]);
  }
  for(const line of command.lines) {
    const article=articles.find(candidate=>candidate.article_id===line.article_id)!;
    await db.query(`INSERT INTO public.client_contract_lines(contract_id,article_id,root_article_id,replenishment_qty,unit_id,
        configured_code,configured_designation,configured_indice,configured_piece_technique_version_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9::uuid)
      ON CONFLICT(contract_id,root_article_id) DO UPDATE SET article_id=excluded.article_id,
        replenishment_qty=excluded.replenishment_qty,unit_id=excluded.unit_id,active=true,
        configured_code=excluded.configured_code,configured_designation=excluded.configured_designation,
        configured_indice=excluded.configured_indice,configured_piece_technique_version_id=excluded.configured_piece_technique_version_id`,
    [id,article.article_id,article.root_article_id,line.replenishment_qty,article.unit_id,
      article.code,article.designation,article.indice,article.piece_technique_version_id]);
  }
}
export async function closeClientContract(db:Queryer,clientId:string,id:string,actor:number) {
  await db.query(`UPDATE public.client_contracts SET status='CLOSED',version=version+1,updated_by=$3,updated_at=now()
    WHERE id=$1::uuid AND client_id=$2`,[id,clientId,actor]);
}
export async function appendContractEvent(db:Queryer,input:{id:string;clientId:string;contractId:string;actor:number;
  key:string;hash:string;action:ClientContractCommand["action"];before:ClientContract|null;result:ClientContractResult;reason:string|null}) {
  await db.query(`INSERT INTO public.client_contract_events(id,client_id,contract_id,actor_user_id,idempotency_key,request_hash,
    action,previous_snapshot,result_payload,reason) VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8::jsonb,$9::jsonb,$10)`,
  [input.id,input.clientId,input.contractId,input.actor,input.key,input.hash,input.action,
    input.before?JSON.stringify(input.before):null,JSON.stringify(input.result),input.reason]);
}
