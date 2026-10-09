import type {PoolClient} from 'pg';
type Queryer=Pick<PoolClient,'query'>;
export async function readClientContractCalls(db:Queryer,clientId:string,contractId:string,page:number) {
  const {rows}=await db.query(`SELECT call.id::text,call.commande_id::text,commande.numero,
    call.customer_reference,commande.code_client AS current_customer_reference,call.order_date::text,
    to_char(call.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    call.contract_version,call.actor_user_id,actor.username AS actor_label,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',binding.id::text,'contract_line_id',binding.contract_line_id::text,
      'commande_ligne_id',binding.commande_ligne_id::text,'article',binding.article_snapshot,
      'initial_qty',binding.initial_qty::text,'current_qty',line.quantite::text,
      'initial_due_date',binding.initial_due_date::text,'current_due_date',line.delai_client,
      'replenishment_qty',binding.replenishment_qty::text) ORDER BY binding.commande_ligne_id)
      FROM public.client_contract_call_lines binding JOIN public.commande_ligne line ON line.id=binding.commande_ligne_id
      WHERE binding.call_id=call.id),'[]'::jsonb) AS lines
    FROM public.client_contract_calls call JOIN public.commande_client commande ON commande.id=call.commande_id
    JOIN public.users actor ON actor.id=call.actor_user_id
    WHERE call.client_id=$1 AND call.contract_id=$2::uuid ORDER BY call.created_at DESC,call.id DESC LIMIT 25 OFFSET $3`,
  [clientId,contractId,(page-1)*25]);
  const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total FROM public.client_contract_calls
    WHERE client_id=$1 AND contract_id=$2::uuid`,[clientId,contractId])).rows[0].total;
  return {items:rows,total,page,page_size:25};
}
export async function readCommandeContractCall(db:Queryer,commandeId:string) {
  return (await db.query(`SELECT call.id::text,call.contract_id::text,call.contract_version,call.contract_snapshot->>'reference' AS reference,
    call.customer_reference,call.order_date::text,COALESCE((SELECT jsonb_agg(jsonb_build_object('commande_ligne_id',binding.commande_ligne_id::text,
      'contract_line_id',binding.contract_line_id::text) ORDER BY binding.commande_ligne_id)
      FROM public.client_contract_call_lines binding WHERE binding.call_id=call.id),'[]'::jsonb) AS lines
    FROM public.client_contract_calls call WHERE call.commande_id=$1::bigint`,[commandeId])).rows[0]??null;
}
