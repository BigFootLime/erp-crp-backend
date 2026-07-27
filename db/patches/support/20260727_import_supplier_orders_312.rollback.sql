\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback #312 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.data_import_batches
    WHERE entity_type = 'FOURNISSEUR_COMMANDE'
  ) THEN
    RAISE EXCEPTION 'Rollback #312 refusé : des lots FOURNISSEUR_COMMANDE existent.';
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
      'ARTICLE',
      'PIECE_TECHNIQUE',
      'MACHINE',
      'STOCK_INITIAL',
      'BL_HISTORIQUE',
      'EMPLOYE'
    )
  );

COMMIT;
