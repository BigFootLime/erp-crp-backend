/** Copy the purchase definition verbatim; only the version and row identities change. */
export const COPY_VERSION_PURCHASES_SQL = `
  INSERT INTO public.pieces_techniques_achats (
    piece_technique_id, piece_technique_version_id, phase, famille_piece_id,
    nom, designation, designation_2, designation_3, article_id,
    fournisseur_id, fournisseur_nom, fournisseur_code,
    quantite, quantite_brut_mm, longueur_mm, coefficient_chute, quantite_pieces,
    prix_par_quantite, tarif, prix, unite_prix, pu_achat, tva_achat,
    total_achat_ht, total_achat_ttc, type_achat
  )
  SELECT piece_technique_id, $2::uuid, phase, famille_piece_id,
         nom, designation, designation_2, designation_3, article_id,
         fournisseur_id, fournisseur_nom, fournisseur_code,
         quantite, quantite_brut_mm, longueur_mm, coefficient_chute, quantite_pieces,
         prix_par_quantite, tarif, prix, unite_prix, pu_achat, tva_achat,
         total_achat_ht, total_achat_ttc, type_achat
    FROM public.pieces_techniques_achats
   WHERE piece_technique_id = $1::uuid AND piece_technique_version_id = $3::uuid
`
