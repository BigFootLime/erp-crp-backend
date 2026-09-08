\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
SELECT current_database(),current_user;
SELECT c.relname,pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid IN (
 'public.supplier_consultations'::regclass,'public.supplier_consultation_invitations'::regclass,
 'public.supplier_consultation_offers'::regclass,'public.supplier_consultation_commands'::regclass);
SELECT id,commande_id,status,source_revision,snapshot,row_version FROM public.supplier_consultations LIMIT 0;
SELECT id,consultation_id,supplier_id,request_text FROM public.supplier_consultation_invitations LIMIT 0;
SELECT id,invitation_id,revision,response,correction_reason FROM public.supplier_consultation_offers LIMIT 0;
SELECT actor_id,command_key,request_hash,result FROM public.supplier_consultation_commands LIMIT 0;
SELECT indexname FROM pg_indexes WHERE tablename='supplier_consultations' AND indexname='supplier_consultation_open_idx';
COMMIT;
