-- Production rollback is restoration into a fresh database from the validated
-- pre-migration dump. Destructive in-place rollback is intentionally refused
-- because reset/invitation rows are security audit evidence.

DO $rollback$
BEGIN
  RAISE EXCEPTION
    'SOL-02 repair rollback requires restoration of the validated pre-migration backup into a fresh database';
END
$rollback$;
