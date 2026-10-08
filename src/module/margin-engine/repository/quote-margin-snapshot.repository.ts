import type { PoolClient } from "pg";
import type { MarginCalculationInput, MarginScopeType } from "../domain/margin-engine";

export type QuoteCaptureKind = "ISSUED" | "RECORDED_SENT";

export async function readQuoteMarginSnapshot(db: Pick<PoolClient, "query">, scopeType: MarginScopeType, scopeRef: string) {
  const result = await db.query<{ input_snapshot: MarginCalculationInput; capture_kind: QuoteCaptureKind; captured_at: string }>(`
    SELECT input_snapshot,capture_kind,captured_at::text FROM public.quote_margin_source_snapshots
    WHERE scope_type=$1 AND scope_ref=$2`, [scopeType, scopeRef]);
  return result.rows[0] ?? null;
}

export async function insertQuoteMarginSnapshotTx(tx: PoolClient, quoteId: number, version: number,
  lineId: string | null, input: MarginCalculationInput, kind: QuoteCaptureKind, actor: number | null) {
  await tx.query(`INSERT INTO public.quote_margin_source_snapshots
    (devis_id,quote_version,line_id,scope_type,scope_ref,capture_kind,input_snapshot,captured_by)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [quoteId, version, lineId, input.scope_type, input.scope_ref, kind, JSON.stringify(input), actor]);
}
