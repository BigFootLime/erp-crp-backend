DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.clients WHERE customer_type='INDIVIDUAL') THEN RAISE EXCEPTION '1454 rollback refused: individual client data exists'; END IF;
END $$;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_customer_type_1454_ck;
ALTER TABLE public.clients DROP COLUMN IF EXISTS individual_last_name;
ALTER TABLE public.clients DROP COLUMN IF EXISTS individual_first_name;
ALTER TABLE public.clients DROP COLUMN IF EXISTS customer_type;
