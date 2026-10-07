-- Evaluation evidence does not confer supplier homologation or client approval.
INSERT INTO public.ged_document_classes
 (class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes,approvals_required,retention_months,hold_on_publish,is_active)
VALUES ('CERP_EVALUATION_FOURNISSEUR','QUALITE','Évaluation fournisseur','SOURCE',ARRAY['application/pdf'],ARRAY['pdf'],10485760,1,NULL,true,true)
ON CONFLICT (class_key) DO NOTHING;
CREATE TABLE public.supplier_review_scopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 domaine_code text REFERENCES public.fournisseur_domaines(code) ON DELETE RESTRICT,
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supplier_review_scope_identity_864 ON public.supplier_review_scopes(supplier_id,COALESCE(domaine_code,''));
CREATE TABLE public.supplier_review_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id uuid NOT NULL REFERENCES public.supplier_review_scopes(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0), enabled boolean NOT NULL,
 cadence_months integer NOT NULL CHECK(cadence_months BETWEEN 1 AND 60), first_due date NOT NULL,
 owner_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope_id,revision)
);
CREATE TABLE public.supplier_review_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid NOT NULL REFERENCES public.supplier_review_policies(id) ON DELETE RESTRICT,
 scope_id uuid NOT NULL REFERENCES public.supplier_review_scopes(id) ON DELETE RESTRICT,
 period_from date NOT NULL, period_to date NOT NULL CHECK(period_to>=period_from),
 evaluated_on date NOT NULL CHECK(evaluated_on>=period_to), next_due date NOT NULL CHECK(next_due>evaluated_on),
 outcome text NOT NULL CHECK(outcome IN ('SATISFACTORY','RESERVATIONS','UNSATISFACTORY')),
 quality_score integer CHECK(quality_score BETWEEN 0 AND 5), delivery_score integer CHECK(delivery_score BETWEEN 0 AND 5),
 responsiveness_score integer CHECK(responsiveness_score BETWEEN 0 AND 5),
 observations text NOT NULL CHECK(length(btrim(observations)) BETWEEN 3 AND 4000),
 actions text NOT NULL CHECK(length(btrim(actions)) BETWEEN 3 AND 4000),
 document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
 version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT, evidence_snapshot jsonb NOT NULL,
 supersedes_id uuid UNIQUE REFERENCES public.supplier_review_evaluations(id) ON DELETE RESTRICT,
 correction_reason text CHECK(correction_reason IS NULL OR length(btrim(correction_reason)) BETWEEN 3 AND 500),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(evidence_snapshot)='object'), CHECK((supersedes_id IS NULL)=(correction_reason IS NULL))
);
CREATE INDEX supplier_review_evaluations_scope_864 ON public.supplier_review_evaluations(scope_id,evaluated_on DESC,created_at DESC);
CREATE TABLE public.supplier_review_commands (
 idempotency_key uuid PRIMARY KEY, actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER supplier_review_scopes_immutable_864 BEFORE UPDATE OR DELETE ON public.supplier_review_scopes FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_review_policies_immutable_864 BEFORE UPDATE OR DELETE ON public.supplier_review_policies FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_review_evaluations_immutable_864 BEFORE UPDATE OR DELETE ON public.supplier_review_evaluations FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_review_commands_immutable_864 BEFORE UPDATE OR DELETE ON public.supplier_review_commands FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
REVOKE UPDATE,DELETE,TRUNCATE ON public.supplier_review_scopes,public.supplier_review_policies,public.supplier_review_evaluations,public.supplier_review_commands FROM cerp_app;
GRANT SELECT,INSERT ON public.supplier_review_scopes,public.supplier_review_policies,public.supplier_review_evaluations,public.supplier_review_commands TO cerp_app;
