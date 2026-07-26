-- Verify du correctif bloquant #227 (découvert par #275).
-- Prouve que la création d'une ligne de facture redevient possible.
-- Tout est fait dans une transaction ANNULÉE : aucune donnée ne subsiste.

\echo '=== Base ==='
SELECT current_database() AS database, now() AS checked_at;

\echo ''
\echo '=== La fonction porte bien le test imbrique (attendu: t) ==='
SELECT position('IF TG_TABLE_NAME = ''facture_echeance'' AND TG_OP = ''UPDATE'' THEN' IN prosrc) > 0
         AS nested_guard_present
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'fn_protect_facturation_child_227';

\echo ''
\echo '=== Les 5 triggers pointent toujours sur la fonction corrigee (5 attendus) ==='
SELECT c.relname AS table_name, t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND p.proname = 'fn_protect_facturation_child_227'
ORDER BY 1, 2;

\echo ''
\echo '=== Preuve fonctionnelle : creation d''une ligne de facture (transaction annulee) ==='
BEGIN;

INSERT INTO public.facture (id, numero, client_id, date_emission, statut, total_ht, total_ttc)
SELECT 9990001, 'VERIFY-275-FIX', client_id, CURRENT_DATE, 'DRAFT', 10, 12
FROM public.clients ORDER BY client_id LIMIT 1;

INSERT INTO public.facture_ligne
  (facture_id, ordre, designation, quantite, prix_unitaire_ht, remise_ligne, taux_tva, total_ht, total_ttc)
VALUES (9990001, 1, 'Ligne de verification #275', 1, 10, 0, 20, 10, 12);

SELECT 'facture_ligne creee' AS resultat, count(*) AS lignes
FROM public.facture_ligne WHERE facture_id = 9990001;

\echo '--- immutabilite toujours active : la meme ligne sur une facture emise est bloquee ---'
UPDATE public.facture SET statut = 'emise' WHERE id = 9990001;

DO $verify$
BEGIN
  BEGIN
    UPDATE public.facture_ligne
    SET designation = 'Modification interdite'
    WHERE facture_id = 9990001;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Echec verification #227 : la ligne emise est restée modifiable';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      RAISE NOTICE 'Immutabilite confirmee : le trigger a retourne SQLSTATE 55000';
  END;
END
$verify$;

ROLLBACK;

\echo ''
\echo '=== Preuve d''annulation (aucune facture VERIFY-275-FIX ne subsiste, 0 attendu) ==='
SELECT count(*) AS residus FROM public.facture WHERE numero = 'VERIFY-275-FIX';
