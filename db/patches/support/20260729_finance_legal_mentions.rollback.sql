-- 20260729_finance_legal_mentions.rollback.sql
--
-- RESTREINT À cerp_test. Refuse de s'exécuter ailleurs.
--
-- Le rollback refuse également de continuer dès qu'une pièce financière a figé un
-- instantané d'émetteur : une facture émise est immuable, et retirer la table qui a
-- produit ses mentions reviendrait à supprimer la preuve de ce qui était en vigueur au
-- moment de l'émission. L'instantané lui-même reste intact dans `facture.issuer_snapshot`
-- — il est autoportant, c'est tout l'intérêt d'un instantané — mais on ne détruit pas la
-- source qui permet de l'auditer.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'ROLLBACK refusé : base « % », seul cerp_test est autorisé', current_database();
  END IF;
END $$;

DO $$
DECLARE
  v_emises integer;
BEGIN
  SELECT count(*) INTO v_emises
  FROM public.facture
  WHERE legal_number IS NOT NULL OR issuer_snapshot IS NOT NULL;

  IF v_emises > 0 THEN
    RAISE EXCEPTION 'ROLLBACK refusé : % pièce(s) portent déjà un instantané d''émetteur', v_emises;
  END IF;
END $$;

DROP TRIGGER IF EXISTS finance_legal_mentions_no_overlap_trg
  ON public.finance_legal_mentions;
DROP FUNCTION IF EXISTS public.tg_finance_legal_mentions_no_overlap();
DROP FUNCTION IF EXISTS public.fn_finance_issuer_snapshot(uuid, date);
DROP TABLE IF EXISTS public.finance_legal_mentions;

-- L'entité émettrice amorcée n'est retirée que si rien ne la référence. `factureur` est
-- référencée par clients, commande_client et devis : une suppression aveugle casserait
-- ces liens.
DELETE FROM public.factureur f
WHERE f.biller_id = 'b7c1e5a2-3f4d-4e8b-9a06-380569012000'::uuid
  AND NOT EXISTS (SELECT 1 FROM public.clients         c WHERE c.biller_id = f.biller_id)
  AND NOT EXISTS (SELECT 1 FROM public.commande_client k WHERE k.biller_id = f.biller_id)
  AND NOT EXISTS (SELECT 1 FROM public.devis           d WHERE d.biller_id = f.biller_id);

DELETE FROM public.cerp_schema_migrations
WHERE filename IN (
  '20260729_finance_legal_mentions.sql',
  '20260729_finance_legal_mentions_hardening_221.sql'
);

COMMIT;
