import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  repoGenerateAffairesFromOrderTx,
  type AuditContext as CommandeAuditContext,
} from "../../commande-client/repository/commande-client.repository";

export type NativeFirmOrderLaunchInput = {
  order_id: number;
  order_line_id: number;
  qty_to_produce: number;
  /** Version obtained with the industrial run; omission is review-only. */
  expected_updated_at?: string;
  /** Exactly one firm schedule is the only automatically executable scope. */
  firm_source_ids: readonly string[];
};

export type NativeFirmOrderLaunchResult =
  | { status: "REVIEW"; reason: string }
  | {
      status: "LAUNCHED";
      root_of_id: number;
    };

/**
 * The industrial executor must not make a standalone OF for a customer order:
 * doing so skips the stock, delivery-affair and workflow safeguards and makes
 * a later normal launch ambiguous. This narrow adapter invokes the normal
 * order launch in the caller's transaction only after proving its simple
 * pilot scope. Every other case deliberately remains a review.
 */
export async function tryLaunchSimpleFirmOrderViaNativeWorkflowTx(
  tx: PoolClient,
  input: NativeFirmOrderLaunchInput,
  audit: CommandeAuditContext,
): Promise<NativeFirmOrderLaunchResult> {
  if (
    !Number.isInteger(input.order_id) ||
    input.order_id <= 0 ||
    !Number.isInteger(input.order_line_id) ||
    input.order_line_id <= 0
  )
    return {
      status: "REVIEW",
      reason: "Commande ou ligne ferme invalide : lancement natif non exécuté.",
    };
  if (!Number.isFinite(input.qty_to_produce) || input.qty_to_produce <= 0)
    return {
      status: "REVIEW",
      reason: "Quantité OF pilote invalide : lancement natif non exécuté.",
    };
  if (!input.expected_updated_at)
    return {
      status: "REVIEW",
      reason:
        "Version de commande absente : relancez l’analyse avant le lancement natif.",
    };
  if (input.firm_source_ids.length !== 1)
    return {
      status: "REVIEW",
      reason:
        "Plusieurs échéances fermes sont concernées : arbitrage commercial requis.",
    };

  const row = (
    await tx.query<{
      updated_at: string | null;
      due_date: string | null;
      order_type: string;
      creation_flow_version: number;
      line_count: number;
      schedule_count: number;
      contract_bound: boolean;
      already_launched: boolean;
      shipped: boolean;
    }>(
      `SELECT c.updated_at::text,l.delai_client::text AS due_date,c.order_type::text,c.creation_flow_version,
      (SELECT count(*)::int FROM public.commande_ligne all_lines WHERE all_lines.commande_id=c.id) AS line_count,
      (SELECT count(*)::int
         FROM public.commande_ligne_affaire_allocation allocation
         LEFT JOIN public.delivery_promise_roots root ON root.allocation_id=allocation.id
         LEFT JOIN public.delivery_promise_parts part ON part.root_id=root.id AND part.retired_at IS NULL
        WHERE allocation.commande_ligne_id=l.id) AS schedule_count,
      (EXISTS(SELECT 1 FROM public.client_contract_call_lines binding WHERE binding.commande_ligne_id=l.id)
       OR EXISTS(SELECT 1 FROM public.client_contract_legacy_lines legacy WHERE legacy.commande_ligne_id=l.id)) AS contract_bound,
      (EXISTS(SELECT 1 FROM public.commande_to_affaire m WHERE m.commande_id=c.id)
       OR EXISTS(SELECT 1 FROM public.ordres_fabrication o WHERE o.commande_id=c.id AND o.statut::text<>'ANNULE')) AS already_launched,
      EXISTS(SELECT 1 FROM public.bon_livraison_ligne bl_line JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
                WHERE bl_line.commande_ligne_id=l.id AND bl.statut IN ('SHIPPED','DELIVERED')) AS shipped
     FROM public.commande_client c JOIN public.commande_ligne l ON l.commande_id=c.id
     WHERE c.id=$1::bigint AND l.id=$2::bigint FOR UPDATE OF c,l`,
      [input.order_id, input.order_line_id],
    )
  ).rows[0];
  if (!row)
    return {
      status: "REVIEW",
      reason: "Commande ou ligne non retrouvée : lancement natif non exécuté.",
    };
  if (row.order_type !== "FERME")
    return {
      status: "REVIEW",
      reason:
        "Le lancement automatique est limité à une commande ferme hors contrat.",
    };
  if (row.creation_flow_version === 2)
    return {
      status: "REVIEW",
      reason:
        "Flux commande V2 : une validation ADV native est encore requise.",
    };
  if (row.line_count !== 1)
    return {
      status: "REVIEW",
      reason:
        "Plusieurs lignes de commande : regroupement commercial à valider.",
    };
  if (row.schedule_count > 1 || !row.due_date)
    return {
      status: "REVIEW",
      reason:
        "Plusieurs échéances ou échéance incomplète : arbitrage commercial requis.",
    };
  if (row.contract_bound)
    return {
      status: "REVIEW",
      reason: "Ligne rattachée à un contrat : utiliser le circuit contractuel.",
    };
  if (row.shipped)
    return {
      status: "REVIEW",
      reason:
        "Commande déjà expédiée ou partiellement expédiée : révision commerciale requise.",
    };
  if (row.already_launched)
    return {
      status: "REVIEW",
      reason: "Commande déjà lancée : aucun second OF automatique.",
    };
  if (row.updated_at !== input.expected_updated_at)
    return {
      status: "REVIEW",
      reason: "Commande modifiée depuis le calcul : relancez la simulation.",
    };

  await tx.query("SAVEPOINT industrial_native_order_launch");
  try {
    await repoGenerateAffairesFromOrderTx(
      tx,
      String(input.order_id),
      {
        decision: "SHIP_ALL_TOGETHER",
        expected_updated_at: input.expected_updated_at,
        livraison_count: 1,
        lines: [
          {
            commande_ligne_id: input.order_line_id,
            qty_ship_now: 0,
            qty_to_produce: input.qty_to_produce,
          },
        ],
      },
      audit,
    );
    const roots = (await tx.query<{ id: number; correct_quantity: boolean }>(
      `SELECT id::int, quantite_lancee=$3::numeric AS correct_quantity FROM public.ordres_fabrication
       WHERE commande_id=$1::bigint AND commande_ligne_id=$2::bigint AND parent_of_id IS NULL
         AND statut::text<>'ANNULE'`,
      [input.order_id, input.order_line_id, input.qty_to_produce],
    )).rows;
    if (roots.length !== 1 || !roots[0].correct_quantity) {
      await tx.query("ROLLBACK TO SAVEPOINT industrial_native_order_launch");
      await tx.query("RELEASE SAVEPOINT industrial_native_order_launch");
      return {
        status: "REVIEW",
        reason:
          "Le lancement natif n’a pas produit exactement un OF racine vérifiable.",
      };
    }
    await tx.query("RELEASE SAVEPOINT industrial_native_order_launch");
    return { status: "LAUNCHED", root_of_id: roots[0].id };
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT industrial_native_order_launch");
    await tx.query("RELEASE SAVEPOINT industrial_native_order_launch");
    if (
      error instanceof HttpError &&
      [400, 403, 409, 422].includes(error.status)
    )
      return {
        status: "REVIEW",
        reason: `Le workflow commande exige une revue : ${error.message}`,
      };
    throw error;
  }
}
