import db from "../../../config/database";

export async function listAssemblyUsage(id: number) {
  const result = await db.query(
    `WITH source AS (
      SELECT piece_technique_id FROM public.ordres_fabrication WHERE id = $1
    ), requirements AS (
      SELECT r.consuming_of_id AS parent_of_id, SUM(r.quantity_per_parent) AS quantity
      FROM public.of_component_requirements r
      JOIN source s ON s.piece_technique_id = r.component_piece_technique_id
      WHERE r.component_kind = 'FABRICATED' AND r.status <> 'CANCELLED'
      GROUP BY r.consuming_of_id
    ), legacy_children AS (
      SELECT child.parent_of_id, SUM(snapshot.quantite_par_parent) AS quantity
      FROM public.ordres_fabrication child
      JOIN source s ON s.piece_technique_id = child.piece_technique_id
      LEFT JOIN public.of_structure_snapshot snapshot ON snapshot.of_id = child.id
      WHERE child.parent_of_id IS NOT NULL AND child.statut <> 'ANNULE'
        AND NOT EXISTS (SELECT 1 FROM requirements r WHERE r.parent_of_id = child.parent_of_id)
      GROUP BY child.parent_of_id
    ), uses AS (
      SELECT * FROM requirements UNION ALL SELECT * FROM legacy_children
    )
    SELECT o.id::text AS id, o.numero, o.statut, pt.designation, usage.quantity::float8 AS quantity
    FROM uses usage
    JOIN public.ordres_fabrication o ON o.id = usage.parent_of_id
    JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
    WHERE o.statut NOT IN ('ANNULE','TERMINE','CLOTURE')
    ORDER BY o.numero, o.id`, [id],
  );
  return result.rows;
}
