BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.carco_reviews (
 id uuid PRIMARY KEY, client_id varchar NOT NULL REFERENCES public.clients(client_id),
 external_site text NOT NULL, source_version text NOT NULL, source_as_of timestamptz NOT NULL,
 content_sha256 text NOT NULL, source_file_name text NOT NULL, complete_snapshot boolean NOT NULL,
 preview jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), received_by integer NOT NULL REFERENCES public.users(id),
 UNIQUE(client_id,external_site,source_version), UNIQUE(client_id,external_site,source_as_of)
);
CREATE TABLE public.carco_schedule_bindings (
 client_id varchar NOT NULL REFERENCES public.clients(client_id), external_site text NOT NULL,
 order_key text NOT NULL, line_key text NOT NULL, article_code text NOT NULL, schedule_key text NOT NULL,
 actor_id integer NOT NULL REFERENCES public.users(id), recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,external_site,order_key,line_key)
);
ALTER TABLE public.demand_pilot_imports ADD COLUMN carco_review_id uuid UNIQUE REFERENCES public.carco_reviews(id);
CREATE TABLE public.carco_submitted_lines (
 review_id uuid NOT NULL REFERENCES public.carco_reviews(id),
 schedule_identity text NOT NULL, content_sha256 text NOT NULL,
 PRIMARY KEY(review_id,schedule_identity)
);
ALTER TABLE public.commande_documents ADD COLUMN upload_sha256 text;
CREATE UNIQUE INDEX commande_document_pdf_content ON public.commande_documents(commande_id,upload_sha256) WHERE upload_sha256 IS NOT NULL;
-- Orders cancelled before this patch can still own open workflow checkpoints.
WITH latest AS (
 SELECT DISTINCT ON (commande_id) commande_id,nouveau_statut FROM public.commande_historique
 ORDER BY commande_id,date_action DESC,id DESC
)
UPDATE public.commande_client_workflow_checkpoint cp SET status='skipped',updated_at=now(),
 metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('skip_reason','order_cancelled','previous_status',status)
FROM latest WHERE latest.commande_id=cp.commande_id AND latest.nouveau_statut='ANNULE'
 AND cp.status IN ('active','pending','blocked');
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.carco_reviews, public.carco_schedule_bindings, public.carco_submitted_lines TO cerp_app;
END IF; END $$;
COMMIT;
