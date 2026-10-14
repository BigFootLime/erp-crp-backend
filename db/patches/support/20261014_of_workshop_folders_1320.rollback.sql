BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1320-empty-print-model-reviewed' THEN
    RAISE EXCEPTION 'Workshop folder rollback requires explicit reviewed acknowledgement';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_workshop_folders) OR EXISTS(SELECT 1 FROM public.of_workshop_folder_prints)
    OR EXISTS(SELECT 1 FROM public.of_workshop_folder_preparations) OR EXISTS(SELECT 1 FROM public.of_workshop_folder_copies) THEN
    RAISE EXCEPTION 'Workshop folder contains saved evidence; rollback refused';
  END IF;
END $$;
DROP TABLE public.of_workshop_folder_preparations;
DROP TABLE public.of_workshop_folder_prints;
DROP TABLE public.of_workshop_folder_copies;
DROP TABLE public.of_workshop_folders;
DROP FUNCTION public.fn_of_workshop_folder_print_scope_1320();
COMMIT;
