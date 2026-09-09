BEGIN;
SET LOCAL lock_timeout='10s';
ALTER TABLE public.of_material_needs ADD COLUMN of_revision_id uuid REFERENCES public.of_revisions(id);
-- Existing commitments from the initial rollout belong to the active revision.
UPDATE public.of_material_needs n SET of_revision_id=r.id
FROM public.of_revisions r WHERE n.of_id=r.of_id AND r.statut='ACTIVE' AND n.need_kind='CONSOMMABLE';
CREATE INDEX of_material_needs_consumable_revision_idx ON public.of_material_needs(of_id,of_revision_id) WHERE need_kind='CONSOMMABLE';
COMMIT;
