-- This internal rollout must not open an external supplier account.
DO $preflight$ DECLARE already_enabled boolean; BEGIN
  IF to_regclass('public.fournisseurs') IS NULL OR to_regclass('public.commande_fournisseur') IS NULL
    OR to_regclass('public.commande_fournisseur_ligne') IS NULL THEN
    RAISE EXCEPTION 'Supplier order prerequisites are missing';
  END IF;
  IF to_regclass('public.supplier_portal_configuration') IS NOT NULL THEN
    SELECT enabled INTO already_enabled FROM public.supplier_portal_configuration WHERE id;
    IF already_enabled THEN RAISE EXCEPTION 'Supplier portal already active: review its existing scope'; END IF;
  END IF;
END $preflight$;
