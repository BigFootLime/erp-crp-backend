\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF NOT has_table_privilege('cerp_app', 'public.article_devis', 'SELECT')
     OR NOT has_table_privilege('cerp_app', 'public.article_devis', 'INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.article_devis', 'DELETE')
     OR NOT has_table_privilege('cerp_app', 'public.dossier_technique_piece_devis', 'SELECT')
     OR NOT has_table_privilege('cerp_app', 'public.dossier_technique_piece_devis', 'INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.dossier_technique_piece_devis', 'DELETE')
     OR NOT has_table_privilege('cerp_app', 'public.devis_idempotence', 'SELECT')
     OR NOT has_table_privilege('cerp_app', 'public.devis_idempotence', 'INSERT') THEN
    RAISE EXCEPTION 'CERP-AUDIT-002/003 grant verification failed for cerp_app';
  END IF;
END
$verify$;

SELECT relation,
       has_table_privilege('cerp_app', relation, 'SELECT') AS can_select,
       has_table_privilege('cerp_app', relation, 'INSERT') AS can_insert,
       has_table_privilege('cerp_app', relation, 'DELETE') AS can_delete
FROM unnest(ARRAY[
  'public.article_devis',
  'public.dossier_technique_piece_devis',
  'public.devis_idempotence'
]) AS relation;

COMMIT;
