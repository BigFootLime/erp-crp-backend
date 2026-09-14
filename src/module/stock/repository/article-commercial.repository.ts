import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  assertArticleCommercial,
  type ArticleCommercialPatch,
} from "../domain/article-commercial";

export async function syncArticleCommercialTx(
  tx: PoolClient,
  id: string,
  patch: ArticleCommercialPatch,
  actor: number | null,
  creating = false,
) {
  const current = (
    await tx.query<{
      commercial_scope: "CLIENTS" | "CRP" | null;
      internal_reference: string | null;
      article_category: string;
      client_ids: string[];
      tool_id: number | null;
      categories: string[];
      consumption_mode: string;
    }>(
      `
    SELECT a.commercial_scope,a.internal_reference,a.article_category,a.consumption_mode,
      ARRAY(SELECT client_id FROM public.article_client_links c WHERE c.article_id=a.id) AS client_ids,
      ARRAY(SELECT category_code FROM public.article_category_link c WHERE c.article_id=a.id) AS categories,
      (SELECT tool_id FROM public.article_tool_links t WHERE t.article_id=a.id) AS tool_id
    FROM public.articles a WHERE a.id=$1::uuid FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!current)
    throw new HttpError(404, "ARTICLE_NOT_FOUND", "Article introuvable.");
  const scope =
    patch.commercial_scope === undefined
      ? current.commercial_scope
      : patch.commercial_scope;
  const clients = [...new Set(patch.client_ids ?? current.client_ids)].sort();
  const finished =
    current.article_category === "fabrique" ||
    current.categories.includes("piece_finie_fabriquee");
  assertArticleCommercial({
    finished,
    scope,
    clients,
    internalReference: current.internal_reference,
    requireQualification:
      creating ||
      patch.commercial_scope !== undefined ||
      patch.client_ids !== undefined ||
      current.commercial_scope !== null,
  });
  if (patch.commercial_scope !== undefined)
    await tx.query(
      "UPDATE public.articles SET commercial_scope=$2 WHERE id=$1::uuid",
      [id, scope],
    );
  if (patch.client_ids !== undefined) {
    const found = await tx.query(
      "SELECT client_id FROM public.clients WHERE client_id=ANY($1::text[]) FOR SHARE",
      [clients],
    );
    if (found.rows.length !== clients.length)
      throw new HttpError(
        422,
        "ARTICLE_CLIENT_UNKNOWN",
        "Un des clients associés est introuvable.",
      );
    await tx.query(
      "DELETE FROM public.article_client_links WHERE article_id=$1::uuid AND NOT(client_id=ANY($2::text[]))",
      [id, clients],
    );
    await tx.query(
      "INSERT INTO public.article_client_links(article_id,client_id,created_by) SELECT $1::uuid,unnest($2::text[]),$3 ON CONFLICT DO NOTHING",
      [id, clients, actor],
    );
  }
  if (patch.tool_id !== undefined && patch.tool_id !== current.tool_id) {
    const used = (
      await tx.query<{ used: boolean }>(
        `SELECT
      EXISTS(SELECT 1 FROM public.stock_movement_lines WHERE article_id=$1::uuid)
      OR EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes WHERE article_id=$1::uuid)
      OR EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne WHERE article_id=$1::uuid) AS used`,
        [id],
      )
    ).rows[0].used;
    if (used)
      throw new HttpError(
        409,
        "ARTICLE_TOOL_LINK_IN_USE",
        "Le raccordement outillage doit être repris explicitement lorsque des achats, réceptions ou stocks existent déjà.",
      );
    if (patch.tool_id !== null && !current.categories.includes("consommable"))
      throw new HttpError(
        422,
        "ARTICLE_TOOL_MUST_BE_CONSUMABLE",
        "L’outillage appartient à la famille Consommables.",
      );
    if (patch.tool_id !== null && current.consumption_mode !== "UNIT")
      throw new HttpError(
        422,
        "TOOL_CONSUMPTION_MODE",
        "L’outillage doit être défini à l’unité avant le raccordement.",
      );
    await tx.query(
      "DELETE FROM public.article_tool_links WHERE article_id=$1::uuid",
      [id],
    );
    if (patch.tool_id !== null) {
      const tool = await tx.query(
        "SELECT id_outil FROM public.gestion_outils_outil WHERE id_outil=$1 FOR UPDATE",
        [patch.tool_id],
      );
      if (!tool.rows.length)
        throw new HttpError(422, "ARTICLE_TOOL_UNKNOWN", "Outil introuvable.");
      await tx.query(
        "INSERT INTO public.article_tool_links(article_id,tool_id,created_by) VALUES($1::uuid,$2,$3)",
        [id, patch.tool_id, actor],
      );
      // The legacy tool register remains the only physical stock register.
      await tx.query(
        "UPDATE public.articles SET stock_managed=false,lot_tracking=false WHERE id=$1::uuid",
        [id],
      );
    }
  }
  if (patch.tool_id ?? current.tool_id)
    await tx.query(
      "UPDATE public.articles SET stock_managed=false,lot_tracking=false WHERE id=$1::uuid",
      [id],
    );
}
