-- Existing root references remain valid. Sub-pieces can extend their mother's reference.
ALTER TABLE public.pieces_techniques
  DROP CONSTRAINT pieces_techniques_commercial_scope_ck,
  ADD CONSTRAINT pieces_techniques_commercial_scope_ck CHECK (
    (commercial_scope IS NULL OR commercial_scope IN ('CLIENTS', 'CRP'))
    AND CASE WHEN commercial_scope = 'CRP' THEN
      crp_plan_reference IS NOT NULL
      AND crp_plan_reference ~ '^[0-9]{6}( REP (0[1-9]|[1-9][0-9]))*$'
      AND client_id IS NULL AND code_client IS NULL AND client_name IS NULL
    ELSE crp_plan_reference IS NULL END
  );
