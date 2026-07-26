-- Rollback gardé du correctif #227.
--
-- Restaurer la fonction précédente réintroduirait le défaut qui bloque tout
-- INSERT/UPDATE de ligne de facture. Le rollback sûr est donc un redéploiement
-- d'une version antérieure *corrigée* de la fonction, jamais le code connu
-- comme défaillant. Ce garde-fou empêche une restauration accidentelle.

DO $$
BEGIN
  RAISE EXCEPTION
    'Rollback automatique refusé : il réintroduirait le trigger Facturation bloquant. Restaurer uniquement une version corrigée et vérifiée de fn_protect_facturation_child_227().';
END
$$;
