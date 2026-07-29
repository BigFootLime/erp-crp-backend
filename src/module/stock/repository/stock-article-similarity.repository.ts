// #226 — Détection d'articles similaires avant création.
//
// Objectif : qu'on ne crée plus « VIS CHC M6 » quand « VIS CHC M6X20 INOX A2 »
// existe déjà. Purement CONSULTATIF — cette recherche ne crée rien, ne verrouille
// rien, et ne bloque aucune création. La barrière dure reste l'unicité du code
// article et, pour les prestations de traitement, `spec_fingerprint`.
//
// « Article manquant » = ABSENT DU RÉFÉRENTIEL. Ni la quantité en stock, ni la
// disponibilité n'entrent ici : un article à zéro existe, il ne se recrée pas.

import db from "../../../config/database";
import type { SimilarArticlesQueryDTO } from "../validators/stock.validators";

export type SimilarArticleMatch = {
  id: string;
  code: string;
  designation: string;
  designation_secondary: string | null;
  article_category: string;
  article_categories: string[];
  family_code: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  status: string | null;
  is_active: boolean;
  archived_at: string | null;
  score: number;
  level: "IDENTIQUE" | "TRES_PROCHE" | "PROCHE";
  reasons: string[];
};

/** Aligné sur `SIMILARITY_FLOOR` du module Finitions : même notion, même seuil. */
const SIMILARITY_FLOOR = 0.34;
const VERY_CLOSE_FLOOR = 0.62;

type Row = {
  id: string;
  code: string;
  designation: string;
  designation_secondary: string | null;
  article_category: string;
  article_categories: string[] | null;
  family_code: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  status: string | null;
  is_active: boolean;
  archived_at: string | null;
  score: string | number;
  exact_designation: boolean;
  same_category: boolean;
  same_family: boolean;
  same_piece: boolean;
};

export async function repoFindSimilarArticles(query: SimilarArticlesQueryDTO): Promise<SimilarArticleMatch[]> {
  const res = await db.query<Row>(
    `WITH candidat AS (
       SELECT
         a.id, a.code, a.designation, a.designation_secondary,
         a.article_category, a.family_code, a.piece_technique_id,
         a.status, a.is_active, a.archived_at,
         -- La désignation secondaire compte : c'est souvent là qu'est écrit le
         -- vrai libellé fournisseur. On garde le meilleur des deux.
         GREATEST(
           similarity(lower(public.unaccent(a.designation)), lower(public.unaccent($1))),
           COALESCE(similarity(lower(public.unaccent(a.designation_secondary)), lower(public.unaccent($1))), 0)
         ) AS base_score,
         (lower(public.unaccent(btrim(a.designation))) = lower(public.unaccent(btrim($1)))) AS exact_designation,
         ($2::text IS NOT NULL AND a.article_category = $2::text) AS same_category,
         ($3::text IS NOT NULL AND a.family_code = $3::text) AS same_family,
         ($4::uuid IS NOT NULL AND a.piece_technique_id = $4::uuid) AS same_piece
       FROM public.articles a
       WHERE ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM public.article_category_link acl
                WHERE acl.article_id = a.id AND acl.category_code = $5::text
              ))
     )
     SELECT
       c.id::text AS id, c.code, c.designation, c.designation_secondary,
       c.article_category, c.family_code,
       c.piece_technique_id::text AS piece_technique_id,
       pt.code_piece AS piece_code,
       c.status, c.is_active, c.archived_at::text AS archived_at,
       c.exact_designation, c.same_category, c.same_family, c.same_piece,
       COALESCE(acl.categories, ARRAY[]::text[]) AS article_categories,
       LEAST(
         1.0,
         c.base_score
         + CASE WHEN c.same_category THEN 0.10 ELSE 0 END
         + CASE WHEN c.same_family   THEN 0.10 ELSE 0 END
         -- Deux articles sur la MÊME pièce technique sont presque toujours le
         -- même besoin exprimé deux fois : c'est le signal le plus fort.
         + CASE WHEN c.same_piece    THEN 0.30 ELSE 0 END
       )::numeric AS score
     FROM candidat c
     LEFT JOIN public.pieces_techniques pt ON pt.id = c.piece_technique_id
     LEFT JOIN LATERAL (
       SELECT array_agg(l.category_code ORDER BY l.is_primary DESC, l.category_code) AS categories
       FROM public.article_category_link l
       WHERE l.article_id = c.id
     ) acl ON true
     WHERE c.exact_designation OR c.base_score >= $6::real
     ORDER BY c.exact_designation DESC, score DESC, c.designation
     LIMIT $7`,
    [
      query.designation,
      query.article_category ?? null,
      query.family_code ?? null,
      query.piece_technique_id ?? null,
      query.business_category ?? null,
      SIMILARITY_FLOOR,
      query.limit,
    ]
  );

  return res.rows.map((row) => {
    const score = typeof row.score === "string" ? Number(row.score) : row.score;
    const level: SimilarArticleMatch["level"] = row.exact_designation
      ? "IDENTIQUE"
      : score >= VERY_CLOSE_FLOOR
        ? "TRES_PROCHE"
        : "PROCHE";

    const reasons: string[] = [];
    if (row.exact_designation) reasons.push("Désignation identique");
    if (row.same_piece) reasons.push("Même pièce technique");
    if (row.same_category) reasons.push("Même catégorie");
    if (row.same_family) reasons.push("Même famille");
    // Un article archivé ou désactivé se réactive ; il ne se recrée pas.
    if (row.archived_at) reasons.push("Archivé — à réactiver plutôt qu'à recréer");
    else if (!row.is_active) reasons.push("Inactif — à réactiver plutôt qu'à recréer");

    return {
      id: row.id,
      code: row.code,
      designation: row.designation,
      designation_secondary: row.designation_secondary,
      article_category: row.article_category,
      article_categories: row.article_categories ?? [],
      family_code: row.family_code,
      piece_technique_id: row.piece_technique_id,
      piece_code: row.piece_code,
      status: row.status,
      is_active: row.is_active,
      archived_at: row.archived_at,
      score: Math.round(score * 1000) / 1000,
      level,
      reasons,
    };
  });
}
