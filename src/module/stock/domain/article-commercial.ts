import { HttpError } from "../../../utils/httpError";

export type ArticleCommercialPatch = {
  commercial_scope?: "CLIENTS" | "CRP" | null;
  client_ids?: string[];
  tool_id?: number | null;
};
export function assertArticleCommercial(input: {
  finished: boolean;
  scope: string | null;
  clients: string[];
  internalReference: string | null;
  requireQualification: boolean;
}) {
  if (!input.finished && (input.scope || input.clients.length))
    throw new HttpError(
      422,
      "ARTICLE_COMMERCIAL_NOT_APPLICABLE",
      "Le choix client ou CRP est réservé aux articles finis.",
    );
  if (input.finished && input.requireQualification && !input.scope)
    throw new HttpError(
      422,
      "ARTICLE_COMMERCIAL_SCOPE_REQUIRED",
      "Choisissez Article client ou Article CRP.",
    );
  if (input.scope === "CLIENTS" && !input.clients.length)
    throw new HttpError(
      422,
      "ARTICLE_CLIENT_REQUIRED",
      "Associez au moins un client à cet article.",
    );
  if (
    input.scope === "CRP" &&
    (input.clients.length || !input.internalReference?.trim())
  )
    throw new HttpError(
      422,
      "ARTICLE_CRP_INVALID",
      "Un article CRP exige une référence interne et aucune association client.",
    );
  if (!input.scope && input.clients.length)
    throw new HttpError(
      422,
      "ARTICLE_COMMERCIAL_SCOPE_REQUIRED",
      "Sélectionnez Article client pour associer des clients.",
    );
}
