import type { PoolClient } from 'pg';
import type { ContractReplenishmentPreparation, PreparedContractReplenishmentPlan,
  PreparedContractReplenishmentProposal, PreparedContractReplenishmentResult } from '../types/client-contract-replenishment.types';

type Queryer = Pick<PoolClient, 'query'>;
const PLAN_FIELDS = `p.id::text,p.contract_id::text,p.contract_version,p.status,'PREPARATION_ONLY'::text AS purpose,
  p.fingerprint,p.coverage_snapshot_hash,to_char(p.start_month,'YYYY-MM') AS start_month,p.months,p.as_of_date::text,
  p.created_at::text,p.created_by,actor.username AS actor_label`;
export async function readReplenishmentPlan(db: Queryer, contractId: string, planId?: string) {
  const plan = (await db.query<Omit<PreparedContractReplenishmentPlan, 'proposals'>>(`SELECT ${PLAN_FIELDS}
    FROM public.client_contract_replenishment_plans p JOIN public.users actor ON actor.id=p.created_by
    WHERE p.contract_id=$1::uuid AND ${planId ? 'p.id=$2::uuid' : "p.status='CURRENT'"}`, planId ? [contractId, planId] : [contractId])).rows[0];
  if (!plan) return null;
  const proposals = (await db.query<PreparedContractReplenishmentProposal>(`SELECT id::text,plan_id::text,contract_line_id::text,
    article_snapshot AS article,to_char(month,'YYYY-MM') AS month,target_date::text,target_overdue,
    lot_quantity::text,lot_count::text,proposed_quantity::text,surplus_quantity::text
    FROM public.client_contract_replenishment_proposals WHERE plan_id=$1::uuid ORDER BY month,article_snapshot->>'code',id`, [plan.id])).rows;
  return { ...plan, proposals };
}
export async function readReplenishmentReplay(db: Queryer, actor: number, key: string) {
  return (await db.query<{ request_hash: string; result_payload: PreparedContractReplenishmentResult }>(`SELECT request_hash,result_payload
    FROM public.client_contract_replenishment_events WHERE actor_user_id=$1 AND idempotency_key=$2::uuid`, [actor, key])).rows[0] ?? null;
}
export async function insertReplenishmentPlan(db: Queryer, input: { id: string; actor: number;
  previousId: string | null; preparation: ContractReplenishmentPreparation; proposals: PreparedContractReplenishmentProposal[] }) {
  if (input.previousId) await db.query(`UPDATE public.client_contract_replenishment_plans SET status='SUPERSEDED'
    WHERE id=$1::uuid AND contract_id=$2::uuid AND status='CURRENT'`, [input.previousId, input.preparation.report.contract_id]);
  const { report } = input.preparation;
  await db.query(`INSERT INTO public.client_contract_replenishment_plans(id,contract_id,contract_version,fingerprint,
    coverage_snapshot_hash,start_month,months,as_of_date,coverage_snapshot,created_by)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::date,$7,$8::date,$9::jsonb,$10)`, [input.id, report.contract_id,
    report.contract_version, input.preparation.fingerprint, report.snapshot_hash, report.start_month + '-01', report.months,
    input.preparation.as_of_date, JSON.stringify(report), input.actor]);
  if (input.proposals.length) await db.query(`INSERT INTO public.client_contract_replenishment_proposals(id,plan_id,contract_id,
    contract_line_id,article_id,root_article_id,unit_id,article_snapshot,month,target_date,target_overdue,
    lot_quantity,lot_count,proposed_quantity,surplus_quantity)
    SELECT id,plan_id,$2::uuid,contract_line_id,(article->>'article_id')::uuid,(article->>'root_article_id')::uuid,
      (article->>'unit_id')::uuid,article,month::date,target_date,target_overdue,lot_quantity,lot_count,proposed_quantity,surplus_quantity
    FROM jsonb_to_recordset($1::jsonb) AS source(id uuid,plan_id uuid,contract_line_id uuid,article jsonb,month text,
      target_date date,target_overdue boolean,lot_quantity numeric,lot_count bigint,proposed_quantity numeric,surplus_quantity numeric)`,
  [JSON.stringify(input.proposals.map(proposal => ({ ...proposal, month: proposal.month + '-01' }))), report.contract_id]);
}
export async function appendReplenishmentEvent(db: Queryer, input: { eventId: string; contractId: string; actor: number;
  key: string; hash: string; previousId: string | null; result: PreparedContractReplenishmentResult }) {
  await db.query(`INSERT INTO public.client_contract_replenishment_events(id,plan_id,contract_id,actor_user_id,idempotency_key,
    request_hash,previous_plan_id,result_payload) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::uuid,$8::jsonb)`,
  [input.eventId, input.result.plan.id, input.contractId, input.actor, input.key, input.hash, input.previousId, JSON.stringify(input.result)]);
}
export async function readReplenishmentHistory(db: Queryer, contractId: string, planId: string, page: number) {
  const items = (await db.query(`SELECT e.id::text,e.created_at::text,actor.username AS actor_label,
    e.previous_plan_id::text,e.result_payload FROM public.client_contract_replenishment_events e
    JOIN public.users actor ON actor.id=e.actor_user_id WHERE e.contract_id=$1::uuid AND e.plan_id=$2::uuid
    ORDER BY e.created_at DESC,e.id DESC LIMIT 25 OFFSET $3`, [contractId, planId, (page - 1) * 25])).rows;
  const total = (await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.client_contract_replenishment_events
    WHERE contract_id=$1::uuid AND plan_id=$2::uuid`, [contractId, planId])).rows[0].total;
  return { items, total, page, page_size: 25 };
}
