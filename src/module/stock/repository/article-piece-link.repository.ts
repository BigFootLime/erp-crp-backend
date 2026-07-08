// src/module/stock/repository/article-piece-link.repository.ts
// GPAO B5 — lectures agrégées du lien Article fabriqué ↔ Pièce technique ↔ Version.
// L'indice n'est JAMAIS lu sur l'article : il vient de la version APPLICABLE de la pièce liée.
import db from "../../../config/database"

export type ArticleDefinitionTechnique = {
  article: {
    id: string
    code: string
    designation: string
    article_category: string
    piece_technique_id: string | null
  }
  linked: boolean
  piece: { id: string; code_piece: string; designation: string; statut: string } | null
  applicable_version: {
    id: string
    indice: string
    statut: string
    plan_reference: string | null
    matiere_prevue: string | null
    date_application: string | null
  } | null
  has_applicable_version: boolean
  warning: string | null
  counts: { operations: number; sous_pieces: number; achats: number }
}

export type PieceArticlePrincipal = {
  id: string
  code: string
  designation: string
  status: string
  article_category: string
  stock_managed: boolean
} | null

// Renvoie null si l'article n'existe pas (→ 404). Sinon un agrégat "définition technique".
export async function repoGetArticleDefinitionTechnique(articleId: string): Promise<ArticleDefinitionTechnique | null> {
  const a = await db.query<{
    id: string
    code: string
    designation: string
    article_category: string
    piece_technique_id: string | null
  }>(
    `SELECT id::text AS id, code, designation, article_category, piece_technique_id::text AS piece_technique_id
     FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  )
  const art = a.rows[0]
  if (!art) return null

  const base = {
    article: {
      id: art.id,
      code: art.code,
      designation: art.designation,
      article_category: art.article_category,
      piece_technique_id: art.piece_technique_id,
    },
  }

  if (!art.piece_technique_id) {
    return {
      ...base,
      linked: false,
      piece: null,
      applicable_version: null,
      has_applicable_version: false,
      warning: art.article_category === "fabrique" ? "Définition technique manquante" : null,
      counts: { operations: 0, sous_pieces: 0, achats: 0 },
    }
  }

  const pieceId = art.piece_technique_id
  const [p, v, c] = await Promise.all([
    db.query<{ id: string; code_piece: string; designation: string; statut: string }>(
      `SELECT id::text AS id, code_piece, designation, statut FROM public.pieces_techniques WHERE id = $1::uuid`,
      [pieceId]
    ),
    db.query<{
      id: string
      indice: string
      statut: string
      plan_reference: string | null
      matiere_prevue: string | null
      date_application: string | null
    }>(
      `SELECT id::text AS id, indice, statut, plan_reference, matiere_prevue, date_application::text AS date_application
       FROM public.piece_technique_versions
       WHERE piece_technique_id = $1::uuid AND statut = 'APPLICABLE'
       ORDER BY date_application DESC NULLS LAST LIMIT 1`,
      [pieceId]
    ),
    db.query<{ operations: string; sous_pieces: string; achats: string }>(
      `SELECT
         (SELECT count(*) FROM public.pieces_techniques_operations WHERE piece_technique_id = $1::uuid) AS operations,
         (SELECT count(*) FROM public.pieces_techniques_nomenclature WHERE parent_piece_technique_id = $1::uuid) AS sous_pieces,
         (SELECT count(*) FROM public.pieces_techniques_achats WHERE piece_technique_id = $1::uuid) AS achats`,
      [pieceId]
    ),
  ])

  const version = v.rows[0] ?? null
  const counts = c.rows[0]
  return {
    ...base,
    linked: true,
    piece: p.rows[0] ?? null,
    applicable_version: version,
    has_applicable_version: !!version,
    warning: version ? null : "Aucune version applicable pour cette pièce",
    counts: {
      operations: Number(counts?.operations ?? 0),
      sous_pieces: Number(counts?.sous_pieces ?? 0),
      achats: Number(counts?.achats ?? 0),
    },
  }
}

// Article fabriqué principal d'une pièce, lu CÔTÉ CANONIQUE (articles.piece_technique_id),
// pas via pieces_techniques.article_id (sujet à dérive). Renvoie null si aucun.
export async function repoGetPieceArticlePrincipal(pieceTechniqueId: string): Promise<PieceArticlePrincipal> {
  const r = await db.query<NonNullable<PieceArticlePrincipal>>(
    `SELECT id::text AS id, code, designation, status, article_category, stock_managed
     FROM public.articles
     WHERE piece_technique_id = $1::uuid AND article_category = 'fabrique'
     LIMIT 1`,
    [pieceTechniqueId]
  )
  return r.rows[0] ?? null
}
