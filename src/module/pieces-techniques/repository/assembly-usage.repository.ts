import db from "../../../config/database";
import { applicableBomScopeSql } from "./bom-version-scope.sql";

export async function listAssemblyUsage(id: string) {
  const result = await db.query(
    `SELECT DISTINCT n.id, parent.id AS piece_id, COALESCE(v.code_metier, parent.code_piece) AS code,
      parent.designation, v.indice, v.version_interne, v.statut AS version_status,
      n.rang, n.repere, n.quantite::float8 AS quantity
    FROM public.pieces_techniques_nomenclature n
    JOIN public.pieces_techniques parent ON parent.id = n.parent_piece_technique_id
    LEFT JOIN LATERAL (
      SELECT pv.id, pv.code_metier, pv.indice, pv.version_interne, pv.statut
      FROM public.piece_technique_versions pv
      WHERE pv.piece_technique_id = parent.id AND pv.statut <> 'OBSOLETE'
      ORDER BY CASE pv.statut WHEN 'APPLICABLE' THEN 0 ELSE 1 END, pv.version_interne DESC, pv.created_at DESC
      LIMIT 1
    ) preferred ON n.parent_piece_technique_version_id IS NULL
    LEFT JOIN public.piece_technique_versions v ON v.piece_technique_id = parent.id AND
      v.id = COALESCE(n.parent_piece_technique_version_id, preferred.id)
    WHERE n.child_piece_technique_id = $1::uuid AND parent.statut::text <> 'OBSOLETE' AND parent.deleted_at IS NULL
      AND (v.id IS NULL OR v.statut <> 'OBSOLETE')
      AND ${applicableBomScopeSql("n", "parent.id", "v.id")}
    ORDER BY code, v.indice, v.version_interne DESC, n.rang, n.id`, [id],
  );
  return result.rows;
}
