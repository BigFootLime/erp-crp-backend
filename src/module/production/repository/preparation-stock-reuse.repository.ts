import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import {
  assertStockConsumptionAllowed,
  lockStockStates,
  stockTargetKey,
} from "../../stock/repository/stock.repository";
import type { AuditContext } from "./production.repository";
import {
  reserveProducedComponentForParentOf,
  reserveProducedQtyForCommandeLine,
} from "./production-receipts.repository";
import {
  assertPreparationMutable,
  evaluateOfPreparation,
  loadPreparationOrder,
  persistPreparationEvaluation,
  preparationAudit,
} from "./production-preparation.repository";
import { sourceHash } from "../domain/preparation-rules";

export type StockReuseInput = {
  expected_updated_at: string;
  source_hash: string;
  lot_id: string;
  stock_batch_id: string;
  quantity: number;
  disposition: "REUSE" | "REWORK";
  justification: string;
  approval_reference: string;
  idempotency_key: string;
};
export async function repoReusePreparationStock(
  id: number,
  input: StockReuseInput,
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `stock-reuse:${input.idempotency_key}`,
    ]);
    const hash = sourceHash({ id, input });
    const prior = (
      await tx.query<{ request_hash: string }>(
        "SELECT request_hash FROM public.of_stock_reuse_decisions WHERE idempotency_key=$1::uuid",
        [input.idempotency_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette décision correspond à une autre demande.",
        );
      return persistPreparationEvaluation(tx, id);
    }
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, input.expected_updated_at);
    if (!of.version_id || of.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "OF_STOCK_REVIEW_LOCKED",
        "Examinez le stock avant de figer la définition de fabrication.",
      );
    await tx.query("SELECT public.fn_assert_of_not_covered_712($1)", [id]);
    const evaluation = await evaluateOfPreparation(tx, id);
    if (evaluation.stock_hash !== input.source_hash)
      throw new HttpError(
        409,
        "STOCK_CHANGED",
        "Les disponibilités ont changé. Actualisez les lots.",
      );
    const lot = evaluation.stock_candidates.find(
      (l) =>
        l.lot_id === input.lot_id && l.stock_batch_id === input.stock_batch_id,
    );
    if (
      !lot ||
      lot.article_id !== of.article_id ||
      input.quantity > Math.min(lot.qty_available, of.quantite_lancee)
    )
      throw new HttpError(
        422,
        "STOCK_REUSE_QUANTITY",
        "Sélectionnez un lot du même article et une quantité disponible inférieure au besoin.",
      );
    let reservationId: string | null = null;
    if (input.disposition === "REUSE") {
      // A lot keeps its original technical index. The signed directional
      // decision is scoped to this exact demand, lot and quantity.
      const currentLot = (
        await tx.query<{ lot_status: string }>(
          "SELECT COALESCE(lot_status,'LIBERE') AS lot_status FROM public.lots WHERE id=$1::uuid FOR UPDATE",
          [lot.lot_id],
        )
      ).rows[0];
      if (!currentLot || currentLot.lot_status !== "LIBERE")
        throw new HttpError(
          409,
          "STOCK_LOT_NOT_RELEASED",
          "Le lot doit être libéré avant sa réservation.",
        );
      // ADR-0070: historical OLD stock has no retrospective CERP quality
      // dossier. Its released state, physical availability and signed index
      // compatibility remain mandatory; NEW/unknown keep the quality gate.
      if (lot.stock_scope !== "OLD") {
        await assertOperationalLotQualityEligibility({
          client: tx,
          lotId: lot.lot_id,
          qty: input.quantity,
          purpose: "RESERVE",
        });
      }
      const target = {
        stock_level_id: lot.stock_level_id,
        stock_batch_id: lot.stock_batch_id,
      };
      const states = await lockStockStates(tx, [target]);
      const state = states.get(stockTargetKey(target));
      if (!state)
        throw new HttpError(
          409,
          "STOCK_CHANGED",
          "Le lot n’est plus disponible.",
        );
      assertStockConsumptionAllowed(state, {
        movement_type: "RESERVE",
        qty: input.quantity,
      });
      const children = (
        await tx.query<{
          id: number;
          quantite_lancee: number;
          technical_snapshot_sha256: string | null;
          statut: string;
        }>(
          `WITH RECURSIVE tree AS(SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1 AND statut<>'ANNULE' UNION ALL SELECT o.id FROM public.ordres_fabrication o JOIN tree t ON o.parent_of_id=t.id WHERE o.statut<>'ANNULE')
        SELECT o.id::bigint::int,o.quantite_lancee::float8,o.technical_snapshot_sha256,o.statut::text FROM public.ordres_fabrication o JOIN tree t ON t.id=o.id ORDER BY o.id FOR UPDATE OF o`,
          [id],
        )
      ).rows;
      if (
        children.some(
          (c) => c.statut !== "BROUILLON" || c.technical_snapshot_sha256,
        )
      )
        throw new HttpError(
          409,
          "CHILD_OF_ENGAGED",
          "Un sous-OF est déjà préparé ou engagé. Révisez son besoin avant de réduire l’assemblage.",
        );
      const demand = (
        await tx.query<{
          commande_ligne_id: number | null;
          affaire_id: number | null;
        }>(
          "SELECT commande_ligne_id::bigint::int,affaire_id::bigint::int FROM public.ordres_fabrication WHERE id=$1",
          [id],
        )
      ).rows[0];
      const args = {
        article_id: lot.article_id,
        location_id: lot.location_id,
        stock_level_id: lot.stock_level_id,
        stock_batch_id: input.stock_batch_id,
        lot_id: lot.lot_id,
        qty_ok: input.quantity,
        actor_user_id: audit.user_id,
        source_scope: lot.stock_scope,
        quality_gate_already_held: true,
      };
      const component = await reserveProducedComponentForParentOf(tx, {
        ...args,
        component_of_id: id,
      });
      const reserved = component.matched
        ? component
        : demand.commande_ligne_id
          ? await reserveProducedQtyForCommandeLine(tx, {
              ...args,
              of_id: id,
              commande_ligne_id: demand.commande_ligne_id,
              livraison_affaire_id: demand.affaire_id,
            })
          : null;
      if (
        !reserved?.reservation_id ||
        Math.abs(reserved.qty_reserved - input.quantity) > 0.000001
      )
        throw new HttpError(
          409,
          "STOCK_DEMAND_CHANGED",
          "Le besoin de livraison ou de composant ne permet plus cette affectation.",
        );
      reservationId = reserved.reservation_id;
      const remaining =
        Math.round((of.quantite_lancee - input.quantity) * 1000) / 1000;
      const ids = [id, ...children.map((c) => c.id)];
      const engaged = (
        await tx.query(
          `SELECT 1 FROM public.stock_reservations WHERE of_id=ANY($1::bigint[]) AND status='ACTIVE' AND id<>$2::uuid AND source_type<>'COMMANDE_LIGNE' LIMIT 1`,
          [ids, reservationId],
        )
      ).rows[0];
      if (engaged)
        throw new HttpError(
          409,
          "ASSEMBLY_RESERVATIONS_ENGAGED",
          "Des composants sont déjà réservés. Libérez ces réservations avant de réduire le besoin.",
        );
      const ratio = remaining / of.quantite_lancee;
      for (const node of [
        { id, quantite_lancee: of.quantite_lancee },
        ...children,
      ]) {
        await tx.query(
          `UPDATE public.ordres_fabrication SET quantite_lancee=CASE WHEN $2::numeric>0 THEN round(quantite_lancee*$2,3) ELSE quantite_lancee END,
          statut=CASE WHEN $2::numeric=0 THEN 'ANNULE'::of_status ELSE statut END,technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,
          technical_preparation=technical_preparation||jsonb_build_object('stock_reuse_quantity',COALESCE((technical_preparation->>'stock_reuse_quantity')::numeric,0)+$3::numeric),updated_at=now(),updated_by=$4 WHERE id=$1`,
          [
            node.id,
            ratio,
            node.id === id
              ? input.quantity
              : node.quantite_lancee * (1 - ratio),
            audit.user_id,
          ],
        );
      }
      await tx.query(
        `UPDATE public.of_component_requirements SET required_qty=CASE WHEN $2::numeric>0 THEN round(required_qty*$2,3) ELSE required_qty END,shortage_qty=round(shortage_qty*$2,3),status=CASE WHEN $2::numeric=0 THEN 'CANCELLED' ELSE status END,updated_at=now() WHERE consuming_of_id=ANY($1::bigint[])`,
        [ids, ratio],
      );
    }
    await tx.query(
      `INSERT INTO public.of_stock_reuse_decisions(of_id,target_version_id,source_version_id,lot_id,stock_batch_id,quantity,disposition,justification,approval_reference,reservation_id,idempotency_key,request_hash,created_by)
      VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::uuid,$11::uuid,$12,$13)`,
      [
        id,
        of.version_id,
        lot.piece_technique_version_id,
        lot.lot_id,
        input.stock_batch_id,
        input.quantity,
        input.disposition,
        input.justification,
        input.approval_reference,
        reservationId,
        input.idempotency_key,
        hash,
        audit.user_id,
      ],
    );
    const updated = await evaluateOfPreparation(tx, id);
    await tx.query(
      `INSERT INTO public.of_stock_reviews(of_id,source_hash,decision,reason,reviewed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(of_id) DO UPDATE SET source_hash=excluded.source_hash,decision=excluded.decision,reason=excluded.reason,reviewed_by=excluded.reviewed_by,reviewed_at=now()`,
      [
        id,
        updated.stock_hash,
        input.disposition === "REUSE" ? "RESERVED" : "REWORK",
        input.justification,
        audit.user_id,
      ],
    );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.stock.reuse",
      {
        ...input,
        reservation_id: reservationId,
        source_version_id: lot.piece_technique_version_id,
        target_version_id: of.version_id,
      },
    );
    return persistPreparationEvaluation(tx, id);
  });
}
