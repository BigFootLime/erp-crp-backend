-- Production rollback is restoration from the validated pre-migration dump.
-- In-place deletion is refused because the base unit may be referenced as soon
-- as stock flows resume.

DO $rollback$
BEGIN
  RAISE EXCEPTION
    'SOL-06 unit repair rollback requires restoration of the validated pre-migration backup into a fresh database';
END
$rollback$;
