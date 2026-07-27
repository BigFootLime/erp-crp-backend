-- Issue #312 — ouvrir l'assistant aux commandes fournisseurs CLIPPER.
-- Additif : aucune commande, ligne, réception ni donnée métier existante n'est modifiée.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #312 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;
END
$$;

ALTER TABLE public.data_import_batches
  DROP CONSTRAINT IF EXISTS data_import_batches_entity_ck;

ALTER TABLE public.data_import_batches
  ADD CONSTRAINT data_import_batches_entity_ck CHECK (
    entity_type IN (
      'CLIENT',
      'CLIENT_ENRICHISSEMENT',
      'CLIENT_CONTACT',
      'FOURNISSEUR',
      'FOURNISSEUR_COMMANDE',
      'ARTICLE',
      'PIECE_TECHNIQUE',
      'MACHINE',
      'STOCK_INITIAL',
      'BL_HISTORIQUE',
      'EMPLOYE'
    )
  );

COMMIT;
