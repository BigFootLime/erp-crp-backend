-- #1146: align route creation with the canonical frozen assembly readers.
-- Existing operations and OF snapshots are unchanged; historical patches retain their checksums.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.pieces_techniques_operations
  DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check;
ALTER TABLE public.pieces_techniques_operations
  ADD CONSTRAINT pieces_techniques_operations_type_operation_check
  CHECK (type_operation IS NULL OR type_operation IN
    ('TOURNAGE','FRAISAGE','DECOUPE','REPRISE','ASSEMBLAGE','CONTROLE',
     'LAVAGE','SOUS_TRAITANCE','EMBALLAGE','AUTRE')) NOT VALID;
ALTER TABLE public.pieces_techniques_operations
  VALIDATE CONSTRAINT pieces_techniques_operations_type_operation_check;
COMMIT;
