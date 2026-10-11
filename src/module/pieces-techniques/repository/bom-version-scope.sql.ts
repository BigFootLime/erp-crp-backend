/** Static SQL references only. A legacy BOM is shared only while the piece has
 * no version-scoped BOM at all. An explicitly empty revision must not resurrect
 * legacy components from another index. Keep distinct BOM occurrences. */
export function applicableBomScopeSql(line: string, piece: string, version: string): string {
  return `${line}.parent_piece_technique_id = ${piece} AND (
    ${line}.parent_piece_technique_version_id = ${version} OR (
      ${line}.parent_piece_technique_version_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM public.pieces_techniques_nomenclature scoped_bom
        WHERE scoped_bom.parent_piece_technique_id = ${piece}
          AND scoped_bom.parent_piece_technique_version_id IS NOT NULL
      )
    )
  )`;
}
