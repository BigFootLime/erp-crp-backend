BEGIN;
CREATE TABLE IF NOT EXISTS public.data_cutover_evidence_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES public.data_cutover_batches(id),row_id uuid NOT NULL REFERENCES public.data_cutover_rows(id),field_key text NOT NULL,ged_document_id uuid NOT NULL REFERENCES public.ged_documents(id),snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(row_id,field_key,ged_document_id)
);
CREATE INDEX IF NOT EXISTS data_cutover_evidence_links_batch_row_idx ON public.data_cutover_evidence_links(batch_id,row_id,created_at);
ALTER TABLE public.data_cutover_evidence_links DROP CONSTRAINT IF EXISTS data_cutover_evidence_row_batch_1710_fk;
ALTER TABLE public.data_cutover_evidence_links ADD CONSTRAINT data_cutover_evidence_row_batch_1710_fk
  FOREIGN KEY(row_id,batch_id) REFERENCES public.data_cutover_rows(id,batch_id) ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION public.data_cutover_evidence_immutable_1710() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Cutover evidence links are immutable' USING ERRCODE='23514'; END $$;
DROP TRIGGER IF EXISTS data_cutover_evidence_links_immutable_1710 ON public.data_cutover_evidence_links;
CREATE TRIGGER data_cutover_evidence_links_immutable_1710 BEFORE UPDATE OR DELETE ON public.data_cutover_evidence_links FOR EACH ROW EXECUTE FUNCTION public.data_cutover_evidence_immutable_1710();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT ON public.data_cutover_evidence_links TO cerp_app; REVOKE UPDATE,DELETE,TRUNCATE ON public.data_cutover_evidence_links FROM PUBLIC,cerp_app; END IF; END $$;
COMMIT;
