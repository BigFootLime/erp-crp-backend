DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.supplier_open_contracts) OR EXISTS(SELECT 1 FROM public.supplier_open_contract_commands) THEN RAISE EXCEPTION 'Contract evidence exists. Preserve schema and roll back runtime only.'; END IF;
END $$;
DROP TRIGGER IF EXISTS supplier_contract_purchase_header_861 ON public.commande_fournisseur;
DROP TRIGGER IF EXISTS supplier_contract_purchase_lines_861 ON public.commande_fournisseur_ligne;
DROP FUNCTION IF EXISTS public.guard_supplier_call_purchase_header_861();
DROP FUNCTION IF EXISTS public.guard_supplier_call_purchase_line_861();
DROP TABLE public.supplier_open_contract_call_lines;
DROP FUNCTION IF EXISTS public.guard_supplier_call_line_insert_861();
DROP TABLE public.supplier_open_contract_calls,public.supplier_open_contract_commands;
DROP TABLE public.supplier_open_contract_revisions,public.supplier_open_contracts;
-- Keep the GED class: never remove documents or their holds as a runtime rollback.
