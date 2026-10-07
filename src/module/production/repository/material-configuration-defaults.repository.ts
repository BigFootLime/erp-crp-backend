import type { DossierDb } from './of-dossier.repository';
import type { MaterialArticleDefaults } from '../domain/material-configuration-proposal';
export const MATERIAL_ARTICLE_DEFAULTS_SQL = `SELECT a.id::text,a.code,a.unite,m.client_proprietaire_id::text,
  n.code AS grade,e.code AS condition,se.code AS sub_condition,
  m.longueur_mm::float8,m.longueur_brut_mm::float8,m.diametre_mm::float8,m.largeur_mm::float8,m.epaisseur_mm::float8
  FROM public.articles a LEFT JOIN public.articles_matiere m ON m.article_id=a.id
  LEFT JOIN public.stock_nuances n ON n.id=m.nuance_id LEFT JOIN public.stock_etats e ON e.id=m.etat_id
  LEFT JOIN public.stock_sous_etats se ON se.id=m.sous_etat_id WHERE a.id=ANY($1::uuid[])`;
export const MATERIAL_OPERATION_DEFAULTS_SQL = `SELECT id::text,phase,source_piece_operation_id::text AS "sourceId"
  FROM public.of_operations WHERE id=ANY($1::uuid[]) ORDER BY phase,id`;
export const MATERIAL_GRADE_REFERENCES_SQL = `SELECT code AS id,concat_ws(' · ',code,NULLIF(designation,'')) AS name
  FROM public.stock_nuances WHERE is_active IS NOT FALSE ORDER BY code`;
export const MATERIAL_CONDITION_REFERENCES_SQL = `SELECT code AS id,concat_ws(' · ',code,NULLIF(designation,'')) AS name
  FROM public.stock_etats WHERE is_active IS NOT FALSE ORDER BY code`;
export async function readMaterialConfigurationDefaults(tx: DossierDb, articleIds: string[], operationIds: string[]) {
    const articles = (await tx.query<MaterialArticleDefaults>(MATERIAL_ARTICLE_DEFAULTS_SQL, [articleIds])).rows;
    const operations = (await tx.query<{
        id: string;
        phase: number;
        sourceId: string | null;
    }>(MATERIAL_OPERATION_DEFAULTS_SQL, [operationIds])).rows;
    const grades = (await tx.query<{
        id: string;
        name: string;
    }>(MATERIAL_GRADE_REFERENCES_SQL)).rows;
    const conditions = (await tx.query<{
        id: string;
        name: string;
    }>(MATERIAL_CONDITION_REFERENCES_SQL)).rows;
    return { articles, operations, references: { grades, conditions } };
}
