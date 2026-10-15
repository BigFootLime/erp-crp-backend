-- SOL-05 only: this historical users column predates the additive ledger but
-- is consumed by the 20261014 avatar binding migration itself.
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.e2e_isolated', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SOL-05 avatar prerequisite refused outside isolated cerp_test';
  END IF;
END
$guard$;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS profile_picture text;

COMMIT;
