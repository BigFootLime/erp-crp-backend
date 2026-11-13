/** Copy purchase values and remap their operation/finish links to the working dossier. */
export const COPY_VERSION_PURCHASES_SQL = `
  WITH sources AS MATERIALIZED (
    SELECT p.*, gen_random_uuid() AS new_id FROM public.pieces_techniques_achats p
    WHERE piece_technique_id = $1::uuid AND piece_technique_version_id = $3::uuid
  ), inserted AS (
    INSERT INTO public.pieces_techniques_achats (
      id, piece_technique_id, piece_technique_version_id, phase, famille_piece_id,
      nom, designation, designation_2, designation_3, article_id,
      fournisseur_id, fournisseur_nom, fournisseur_code,
      quantite, quantite_brut_mm, longueur_mm, coefficient_chute, quantite_pieces,
      prix_par_quantite, tarif, prix, unite_prix, pu_achat, tva_achat,
      total_achat_ht, total_achat_ttc, type_achat, gamme_id, gamme_operation_id
    )
    SELECT new_id, piece_technique_id, $2::uuid, phase, famille_piece_id,
           nom, designation, designation_2, designation_3, article_id,
           fournisseur_id, fournisseur_nom, fournisseur_code,
           quantite, quantite_brut_mm, longueur_mm, coefficient_chute, quantite_pieces,
           prix_par_quantite, tarif, prix, unite_prix, pu_achat, tva_achat,
           total_achat_ht, total_achat_ttc, type_achat,
           CASE WHEN gamme_id IS NOT NULL THEN $5::uuid ELSE NULL END,
           ($4::jsonb->>gamme_operation_id::text)::uuid
    FROM sources
    RETURNING id
  )
  SELECT sources.id::text AS old_id, inserted.id::text AS new_id
  FROM sources JOIN inserted ON inserted.id=sources.new_id
`
