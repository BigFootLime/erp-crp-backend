/** Static SQL expressions supplied by the repository, never request input. */
export function currentDossierTotalsSql(pieceId: string, versionId: string): string {
  return `
    LEFT JOIN LATERAL (
      SELECT g.id
      FROM public.gammes g
      WHERE g.piece_technique_version_id = ${versionId}
        AND g.statut <> 'OBSOLETE'
      ORDER BY g.is_current DESC,
        CASE WHEN g.statut = 'APPLICABLE' THEN 0 ELSE 1 END,
        g.updated_at DESC, g.id DESC
      LIMIT 1
    ) dossier_gamme ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS operations_count,
        COALESCE(SUM(op.temps_total), 0)::float8 AS operations_temps_total,
        COALESCE(SUM(op.cout_mo), 0)::float8 AS cout_mo_total
      FROM public.pieces_techniques_operations op
      WHERE op.piece_technique_id = ${pieceId}
        AND (op.gamme_id = dossier_gamme.id OR (
          op.gamme_id IS NULL AND dossier_gamme.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.gammes historical_gamme
            JOIN public.piece_technique_versions historical_version
              ON historical_version.id = historical_gamme.piece_technique_version_id
            WHERE historical_version.piece_technique_id = ${pieceId}
          )
        ))
    ) no ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS achats_count,
        COALESCE(SUM(achat.total_achat_ht), 0)::float8 AS achats_total_ht,
        COALESCE(SUM(achat.total_achat_ttc), 0)::float8 AS achats_total_ttc
      FROM public.pieces_techniques_achats achat
      WHERE achat.piece_technique_id = ${pieceId}
        AND (achat.piece_technique_version_id = ${versionId} OR (
          achat.piece_technique_version_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.pieces_techniques_achats versioned_achat
            WHERE versioned_achat.piece_technique_id = ${pieceId}
              AND versioned_achat.piece_technique_version_id IS NOT NULL
          )
        ))
    ) na ON true
  `
}
