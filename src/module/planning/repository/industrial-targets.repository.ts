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
          (proposal.target_date<$2::date) AS target_overdue,proposal.proposed_quantity::float8
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

/** Also inspect orders too uncertain to count as available supply. They must
 * be reconciled before proposing a second launch against the same shortfall. */
export type RecoveryCommitment = {
  source: string; article: string; reference: string; order_line: string | null; contract_line: string | null;
};
export async function readRecoveryCommitments(tx: Pick<PoolClient, "query">, articles: string[], client: string) {
  if (!articles.length) return [];
  return (await tx.query<RecoveryCommitment>(`
    SELECT 'production:'||o.id AS source, o.article_id::text AS article,o.numero AS reference,
      o.commande_ligne_id::text AS order_line,cp.contract_line_id::text AS contract_line
    FROM public.ordres_fabrication o
    LEFT JOIN public.client_contract_replenishment_roots r ON r.root_of_id=o.id
    LEFT JOIN public.client_contract_replenishment_proposals cp ON cp.id=r.proposal_id
    WHERE o.article_id=ANY($1::uuid[]) AND (o.client_id=$2 OR o.client_id IS NULL)
      AND o.parent_of_id IS NULL AND o.statut::text NOT IN ('TERMINE','CLOTURE','ANNULE')
      AND o.quantite_lancee>o.quantite_rebut+COALESCE((SELECT sum(out.qty_ok) FROM public.of_output_lots out WHERE out.of_id=o.id),0)
    UNION ALL
    SELECT 'oa:'||l.id, l.article_id::text, p.code, null,null
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur p ON p.id=l.commande_id
    WHERE l.article_id=ANY($1::uuid[]) AND l.statut_ligne='ACTIVE' AND p.statut NOT IN ('RECUE','CLOTUREE','ANNULEE')
      AND l.quantite>l.qty_annulee+COALESCE((SELECT sum(x.qty_received) FROM public.reception_fournisseur_lignes x
        JOIN public.receptions_fournisseurs h ON h.id=x.reception_id WHERE h.status<>'CANCELLED' AND x.commande_fournisseur_ligne_id=l.id),0)
    ORDER BY source`, [articles,client])).rows;
}
