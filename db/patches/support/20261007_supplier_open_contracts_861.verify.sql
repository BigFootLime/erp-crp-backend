SELECT to_regclass('public.supplier_open_contracts') IS NOT NULL AS contracts,
 to_regclass('public.supplier_open_contract_revisions') IS NOT NULL AS revisions,
 to_regclass('public.supplier_open_contract_calls') IS NOT NULL AS calls,
 to_regclass('public.supplier_open_contract_call_lines') IS NOT NULL AS call_lines,
 to_regclass('public.supplier_open_contract_commands') IS NOT NULL AS commands;
SELECT count(*) AS guards FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
 ('supplier_open_contract_revisions_immutable_861','supplier_open_contract_calls_immutable_861','supplier_open_contract_call_lines_immutable_861','supplier_open_contract_commands_immutable_861','supplier_open_contract_call_lines_sealed_861','supplier_contract_purchase_lines_861','supplier_contract_purchase_header_861');
SELECT has_table_privilege('cerp_app','public.supplier_open_contract_revisions','SELECT,INSERT') AS revisions_access,
 NOT has_table_privilege('cerp_app','public.supplier_open_contract_revisions','UPDATE,DELETE') AS revision_rewrite_refused;
