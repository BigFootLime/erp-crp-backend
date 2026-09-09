import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { assertConsumablePolicy, type ConsumablePolicy } from "../domain/consumable-policy";

export async function syncConsumablePolicyTx(tx: PoolClient, id: string, patch: ConsumablePolicy,
  state: { article_categories: string[]; stock_managed: boolean; lot_tracking: boolean }) {
  const current = (await tx.query<ConsumablePolicy&{stock_managed:boolean;lot_tracking:boolean}>(`SELECT internal_reference,consumption_mode,stock_managed,lot_tracking,
    purchase_pack_qty::float8,receipt_quality_required FROM public.articles WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
  const next = { ...current, ...patch, ...state };
  assertConsumablePolicy(next);
  if (current&&(patch.consumption_mode !== undefined && patch.consumption_mode !== current.consumption_mode||state.stock_managed!==current.stock_managed||state.lot_tracking!==current.lot_tracking)) {
    const used = (await tx.query<{ used: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM public.stock_levels WHERE article_id=$1::uuid AND (qty_total<>0 OR qty_reserved<>0))
      OR EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
        WHERE l.article_id=$1::uuid AND l.statut_ligne='ACTIVE' AND c.statut NOT IN ('RECUE','CLOTUREE','ANNULEE')) AS used`, [id])).rows[0]?.used;
    if (used) throw new HttpError(409, "CONSUMPTION_MODE_IN_USE", "Le mode de suivi ne peut pas changer tant que du stock ou des commandes restent engagés.");
  }
  if (Object.keys(patch).length) await tx.query(`UPDATE public.articles SET
    internal_reference=CASE WHEN $2 THEN $3 ELSE internal_reference END,
    consumption_mode=COALESCE($4,consumption_mode),purchase_pack_qty=COALESCE($5,purchase_pack_qty),
    receipt_quality_required=COALESCE($6,receipt_quality_required),stock_managed=$7,lot_tracking=$8 WHERE id=$1::uuid`,
    [id, Object.prototype.hasOwnProperty.call(patch, "internal_reference"), patch.internal_reference ?? null,
      patch.consumption_mode ?? null, patch.purchase_pack_qty ?? null, patch.receipt_quality_required ?? null,state.stock_managed,state.lot_tracking]);
}

export function consumablePolicyPatch(input: ConsumablePolicy): ConsumablePolicy {
  return Object.fromEntries(["internal_reference", "consumption_mode", "purchase_pack_qty", "receipt_quality_required"]
    .filter(key => Object.prototype.hasOwnProperty.call(input, key)).map(key => [key, input[key as keyof ConsumablePolicy]]));
}
