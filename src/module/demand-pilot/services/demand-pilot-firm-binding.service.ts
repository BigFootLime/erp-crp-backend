import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

/** ADV-only explicit binding. It proves client, article and current commercial
 * line before a demand worker is ever allowed to revise an AR promise. */
export async function bindFirmDemand(input: {
  revisionId: string;
  clientId: string;
  promiseRootId: string;
  actorId: number;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const demand = (
      await tx.query<any>(
        `SELECT kind,status,article_id::text,contract_id::text,contract_line_id::text,external_site,external_order_key,external_line_key,external_schedule_key FROM public.demand_pilot_revisions WHERE id=$1::uuid AND client_id=$2 FOR UPDATE`,
        [input.revisionId, input.clientId],
      )
    ).rows[0];
    if (!demand)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Demande introuvable.",
      );
    if (
      demand.kind !== "FIRM" ||
      !["PENDING", "REVIEW"].includes(demand.status) ||
      !demand.article_id
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_FIRM_BINDING_STATE",
        "Seule une demande ferme non décidée et article-résolue peut être rattachée.",
      );
    const inherited = (
      await tx.query<any>(
        `SELECT promise_root_id::text,article_id::text,contract_id::text,contract_line_id::text FROM public.demand_pilot_firm_binding_scopes WHERE client_id=$1 AND external_site=$2 AND external_order_key=$3 AND external_line_key=$4 AND external_schedule_key=$5 FOR SHARE`,
        [
          input.clientId,
          demand.external_site,
          demand.external_order_key,
          demand.external_line_key,
          demand.external_schedule_key,
        ],
      )
    ).rows[0];
    if (
      inherited &&
      (inherited.article_id !== demand.article_id ||
        inherited.contract_id !== demand.contract_id ||
        inherited.contract_line_id !== demand.contract_line_id)
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_FIRM_BINDING_REVIEW",
        "La révision modifie le périmètre commercial du rattachement existant.",
      );
    const effectiveRoot = inherited?.promise_root_id ?? input.promiseRootId;
    const root = (
      await tx.query(
        `SELECT 1 FROM public.delivery_promise_roots r JOIN public.commande_client c ON c.id=r.commande_id JOIN public.commande_ligne l ON l.id=r.line_id
      WHERE r.id=$1::uuid AND c.client_id=$2 AND l.article_id=$3::uuid FOR SHARE`,
        [effectiveRoot, input.clientId, demand.article_id],
      )
    ).rows[0];
    if (!root)
      throw new HttpError(
        422,
        "DEMAND_PILOT_FIRM_BINDING_SCOPE",
        "La promesse ne correspond pas au client et à l’article de cette demande.",
      );
    if (!inherited)
      await tx.query(
        `INSERT INTO public.demand_pilot_firm_binding_scopes(client_id,external_site,external_order_key,external_line_key,external_schedule_key,promise_root_id,article_id,contract_id,contract_line_id,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10)`,
        [
          input.clientId,
          demand.external_site,
          demand.external_order_key,
          demand.external_line_key,
          demand.external_schedule_key,
          effectiveRoot,
          demand.article_id,
          demand.contract_id,
          demand.contract_line_id,
          input.actorId,
        ],
      );
    await tx.query(
      `INSERT INTO public.demand_pilot_firm_bindings(revision_id,promise_root_id,bound_by_user_id) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT(revision_id) DO NOTHING`,
      [input.revisionId, effectiveRoot, input.actorId],
    );
    await tx.query("COMMIT");
    return { revision_id: input.revisionId, promise_root_id: effectiveRoot };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
