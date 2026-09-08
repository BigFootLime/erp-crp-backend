import type {PoolClient} from 'pg';
export type ForecastState={status:'PENDING'|'ERROR'|'READY';calculatedAt:string|null;sourceRevision:string|null;issueCount:number;error:string|null};
export async function readForecastState(tx:Pick<PoolClient,'query'>):Promise<ForecastState>{
  const row=(await tx.query(`SELECT s.calculated_at::text AS "calculatedAt",s.source_revision::text AS "sourceRevision",s.issue_count AS "issueCount",s.last_error AS error,
    CASE WHEN s.last_error IS NOT NULL THEN 'ERROR' WHEN EXISTS(SELECT 1 FROM public.planning_recalculation_jobs WHERE processed_at IS NULL) OR s.calculated_at IS NULL THEN 'PENDING' ELSE 'READY' END AS status
    FROM public.planning_forecast_state s WHERE singleton`)).rows[0];
  return row??{status:'PENDING',calculatedAt:null,sourceRevision:null,issueCount:0,error:null};
}
