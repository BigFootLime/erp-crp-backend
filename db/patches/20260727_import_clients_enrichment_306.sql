-- Issue #306 — enrichissement des clients CLIPPER et import idempotent des contacts.
-- Additif : aucune donnée métier existante n'est supprimée ou réécrite par ce patch.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #306 refusé hors cerp_test (base actuelle : %)', current_database();
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

CREATE TABLE IF NOT EXISTS public.client_contact_create_idempotency (
  idempotency_key text PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES public.contacts(contact_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contact_create_idempotency_contact_idx
  ON public.client_contact_create_idempotency (contact_id);

COMMIT;
