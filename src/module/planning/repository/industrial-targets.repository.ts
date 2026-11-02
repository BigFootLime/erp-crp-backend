import type { PoolClient } from "pg";
import { z } from "zod";
import {
  industrialClient,
  industrialDate,
} from "../validators/industrial-plan.validators";
import { readIndustrialPolicy } from "./industrial-policy.repository";
import type { IndustrialPlanTargetRecoverySource } from "../types/industrial-plan.types";
export const targetSchema = z
  .object({
    client_id: industrialClient,
    month: industrialDate.refine(
      (d) => d.endsWith("-01"),
      "Premier jour du mois requis.",
    ),
    family: z.string().trim().min(1).max(100),
    unit: z.string().trim().min(1).max(32),
    revenue_target_eur: z.number().finite().nonnegative().nullable(),
    stock_target: z.number().finite().nonnegative().nullable(),
  })
  .strict();
export async function readPicTargets(
  tx: Pick<PoolClient, "query">,
  client: string,
  start: string,
  months: number,
) {
  return (
    await tx.query<{
      month: string;
      family: string;
      unit: string;
      revenue_target_eur: number | null;
      stock_target: number | null;
    }>(
      `SELECT month::text,family,unit,revenue_target_eur::float8,stock_target::float8 FROM public.industrial_pic_targets
 WHERE client_id=$1 AND month>=date_trunc('month',$2::date) AND month<date_trunc('month',$2::date)+$3::int*interval '1 month' ORDER BY month,family,unit`,
      [client, start, months],
    )
  ).rows;
}
export async function savePicTarget(
  tx: PoolClient,
  actor: number,
  data: z.infer<typeof targetSchema>,
) {
  await readIndustrialPolicy(tx, data.client_id, true);
  const row = (
    await tx.query(
      `INSERT INTO public.industrial_pic_targets(client_id,month,family,unit,revenue_target_eur,stock_target,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(client_id,month,family,unit) DO UPDATE SET revenue_target_eur=excluded.revenue_target_eur,stock_target=excluded.stock_target,updated_by=excluded.updated_by RETURNING month::text,family,unit,revenue_target_eur::float8,stock_target::float8`,
      [
        data.client_id,
        data.month,
        data.family,
        data.unit.toUpperCase(),
        data.revenue_target_eur,
        data.stock_target,
        actor,
      ],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO public.industrial_policy_events(client_id,actor_id,snapshot) VALUES($1,$2,$3)",
    [data.client_id, actor, JSON.stringify({ pic_target: row })],
  );
  return row;
}

/** Current contract preparations are planning evidence only, never stock. */
export async function readOverdueContractTargetPreparations(
  tx: Pick<PoolClient, "query">,
  clientId: string,
  runToday: string,
): Promise<IndustrialPlanTargetRecoverySource[]> {
  const installed = (
    await tx.query<{ installed: boolean }>(
      `SELECT to_regclass('public.client_contract_replenishment_plans') IS NOT NULL
          AND to_regclass('public.client_contract_replenishment_proposals') IS NOT NULL AS installed`,
    )
  ).rows[0]?.installed;
  if (!installed) return [];
  return (
    await tx.query<IndustrialPlanTargetRecoverySource>(
      `SELECT proposal.contract_line_id::text,proposal.article_id::text,
          COALESCE(proposal.article_snapshot->>'code',proposal.article_id::text) AS article,
          upper(COALESCE(proposal.article_snapshot->>'unit','')) AS unit,
          to_char(proposal.month,'YYYY-MM') AS month,proposal.target_date::text,
          proposal.target_overdue,proposal.proposed_quantity::float8
         FROM public.client_contract_replenishment_proposals proposal
         JOIN public.client_contract_replenishment_plans plan ON plan.id=proposal.plan_id
         JOIN public.client_contracts contract ON contract.id=plan.contract_id
        WHERE contract.client_id=$1
          AND plan.status='CURRENT'
          -- Re-evaluate overdue status at run time.  A preparation can be old.
          AND proposal.target_date<$2::date
          AND proposal.proposed_quantity>0
        ORDER BY proposal.target_date,proposal.id`,
      [clientId, runToday],
    )
  ).rows;
}
