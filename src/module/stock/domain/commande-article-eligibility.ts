import { HttpError } from "../../../utils/httpError";

export type CommandeArticleIneligibilityCode =
  | "ARTICLE_INACTIVE"
  | "ARTICLE_NOT_STOCK_MANAGED"
  | "ARTICLE_NOT_FABRICATED"
  | "ARTICLE_PIECE_TECHNIQUE_REQUIRED";

export type CommandeArticleEligibilityState = {
  is_active: boolean;
  stock_managed: boolean;
  article_category: string;
  piece_technique_id: string | null;
};

/** Miroir pur du predicat SQL, utile aux tests et aux doubles de repository. */
export function commandeArticleIneligibilityFromState(
  article: CommandeArticleEligibilityState
): CommandeArticleIneligibilityCode | null {
  if (!article.is_active) return "ARTICLE_INACTIVE";
  if (!article.stock_managed) return "ARTICLE_NOT_STOCK_MANAGED";
  if (article.article_category !== "fabrique" && article.article_category !== "PIECE_TECHNIQUE") {
    return "ARTICLE_NOT_FABRICATED";
  }
  if (!article.piece_technique_id) return "ARTICLE_PIECE_TECHNIQUE_REQUIRED";
  return null;
}

function safeArticleAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
}

/**
 * Catégorie fabriquée canonique d'une commande client.
 *
 * Les valeurs primaires historiques (`PIECE_TECHNIQUE`) restent reconnues. Une catégorie
 * secondaire `piece_finie_fabriquee` ne transforme pas une catégorie primaire matière/achat :
 * ce serait un élargissement métier que la validation Commande canonique n'autorisait pas.
 */
export function commandeArticleFabricatedSql(alias = "a"): string {
  const article = safeArticleAlias(alias);
  return `(${article}.article_category IN ('fabrique', 'PIECE_TECHNIQUE'))`;
}

/** Prédicat unique utilisé par le filtre Stock ET la validation POST/PATCH Commande. */
export function commandeArticleEligibleSql(alias = "a"): string {
  const article = safeArticleAlias(alias);
  return `(
    ${article}.is_active = TRUE
    AND ${article}.stock_managed = TRUE
    AND ${commandeArticleFabricatedSql(article)}
    AND ${article}.piece_technique_id IS NOT NULL
  )`;
}

/** Cause prioritaire, stable et actionnable du refus. */
export function commandeArticleIneligibilityCodeSql(alias = "a"): string {
  const article = safeArticleAlias(alias);
  return `CASE
    WHEN ${article}.is_active IS NOT TRUE THEN 'ARTICLE_INACTIVE'
    WHEN ${article}.stock_managed IS NOT TRUE THEN 'ARTICLE_NOT_STOCK_MANAGED'
    WHEN ${commandeArticleFabricatedSql(article)} IS NOT TRUE THEN 'ARTICLE_NOT_FABRICATED'
    WHEN ${article}.piece_technique_id IS NULL THEN 'ARTICLE_PIECE_TECHNIQUE_REQUIRED'
    ELSE NULL
  END`;
}

export function commandeArticleEligibilityMessage(
  code: CommandeArticleIneligibilityCode,
  articleCode: string
): string {
  switch (code) {
    case "ARTICLE_INACTIVE":
      return `L'article ${articleCode} est inactif. Réactivez-le dans Stock ou choisissez un autre article.`;
    case "ARTICLE_NOT_STOCK_MANAGED":
      return `L'article ${articleCode} n'est pas géré en stock. Activez sa gestion de stock ou choisissez un autre article.`;
    case "ARTICLE_NOT_FABRICATED":
      return `L'article ${articleCode} n'est pas une pièce fabriquée éligible. Choisissez un article fabriqué.`;
    case "ARTICLE_PIECE_TECHNIQUE_REQUIRED":
      return `L'article ${articleCode} doit être relié à une pièce technique avant de pouvoir être commandé.`;
  }
}

export function commandeArticleEligibilityError(params: {
  code: CommandeArticleIneligibilityCode;
  articleId: string;
  articleCode: string;
  lineIndex: number;
}): HttpError {
  return new HttpError(
    409,
    params.code,
    commandeArticleEligibilityMessage(params.code, params.articleCode),
    {
      field: `lignes.${params.lineIndex}.article_id`,
      line_index: params.lineIndex,
      article_id: params.articleId,
      article_code: params.articleCode,
    }
  );
}
