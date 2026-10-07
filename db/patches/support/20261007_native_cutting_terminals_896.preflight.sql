DO $$ BEGIN
 IF to_regclass('public.cerp_terminal_sessions') IS NULL
 OR to_regclass('public.cerp_terminal_pins') IS NULL
 OR to_regclass('public.production_material_debits') IS NULL
 OR to_regclass('public.realtime_session_epochs') IS NULL
 THEN RAISE EXCEPTION 'Canonical native session/material prerequisites missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_terminals'::regclass
   AND conname='cerp_terminals_kind_check' AND convalidated)
 THEN RAISE EXCEPTION 'Terminal kind constraint missing or unvalidated'; END IF;
END $$;
