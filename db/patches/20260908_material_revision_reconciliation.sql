-- #767 / L3: preserve original commitments while explicitly reviewing revisions.
BEGIN;
CREATE TABLE public.of_material_revision_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  previous_need_id uuid NOT NULL UNIQUE REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  target_need_id uuid REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK(disposition IN ('CARRY','KEEP_SEPARATE')),
  reason text NOT NULL CHECK(length(btrim(reason))>=10),
  reviewed_snapshot jsonb NOT NULL,
  command_key uuid NOT NULL REFERENCES public.of_material_commands(idempotency_key) DEFERRABLE INITIALLY DEFERRED,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((disposition='CARRY' AND target_need_id IS NOT NULL AND target_need_id<>previous_need_id)
     OR(disposition='KEEP_SEPARATE' AND target_need_id IS NULL))
);
CREATE TRIGGER of_material_revision_resolutions_immutable BEFORE UPDATE OR DELETE ON public.of_material_revision_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
-- A link redirects the reading of a commitment; its original need FK and all
-- posted quantities remain unchanged. Chains support more than one revision.
CREATE VIEW public.v_of_material_need_destinations AS
WITH RECURSIVE destinations(of_id,source_need_id,target_need_id,path) AS (
  SELECT n.of_id,n.id,n.id,ARRAY[n.id] FROM public.of_material_needs n
  UNION ALL
  SELECT d.of_id,d.source_need_id,r.target_need_id,d.path||r.target_need_id
  FROM destinations d JOIN public.of_material_revision_resolutions r
    ON r.previous_need_id=d.target_need_id AND r.of_id=d.of_id AND r.disposition='CARRY'
  WHERE NOT r.target_need_id=ANY(d.path)
)
SELECT DISTINCT ON(source_need_id) of_id,source_need_id,target_need_id
FROM destinations ORDER BY source_need_id,cardinality(path) DESC;
ALTER TABLE public.of_material_revision_resolutions OWNER TO cerp_app;
ALTER VIEW public.v_of_material_need_destinations OWNER TO cerp_app;
COMMIT;
