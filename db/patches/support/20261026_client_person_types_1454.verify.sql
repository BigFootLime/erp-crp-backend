SELECT customer_type,count(*) FROM public.clients GROUP BY customer_type ORDER BY customer_type;
SELECT conname FROM pg_constraint WHERE conrelid='public.clients'::regclass AND conname='clients_customer_type_1454_ck';
