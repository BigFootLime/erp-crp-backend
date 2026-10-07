-- Customer-required supplier lists are explicit, evidenced and revisioned.
INSERT INTO public.ged_document_classes
 (class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes,approvals_required,retention_months,hold_on_publish,is_active)
VALUES ('CERP_AGREMENT_FOURNISSEUR','QUALITE','Agrément client–fournisseur','SOURCE',ARRAY['application/pdf'],ARRAY['pdf'],10485760,1,NULL,true,true)
ON CONFLICT (class_key) DO NOTHING;

CREATE TABLE public.client_supplier_approval_scopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id varchar(3) NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
 product_article_id uuid REFERENCES public.articles(id) ON DELETE RESTRICT,
 purchase_article_id uuid REFERENCES public.articles(id) ON DELETE RESTRICT,
 domaine_code text NOT NULL REFERENCES public.fournisseur_domaines(code) ON DELETE RESTRICT,
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_supplier_approval_scope_identity_855 ON public.client_supplier_approval_scopes
 (client_id,COALESCE(product_article_id::text,''),COALESCE(purchase_article_id::text,''),domaine_code);

CREATE TABLE public.client_supplier_approval_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 scope_id uuid NOT NULL REFERENCES public.client_supplier_approval_scopes(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 required boolean NOT NULL,
 suspended boolean NOT NULL DEFAULT false,
 exclusive boolean NOT NULL DEFAULT false,
 valid_from date NOT NULL,
 valid_to date CHECK(valid_to IS NULL OR valid_to>=valid_from),
 document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
 version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
 evidence_snapshot jsonb NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_txid bigint NOT NULL DEFAULT txid_current(),
 idempotency_key uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 CHECK(NOT exclusive OR required),
 UNIQUE(scope_id,revision)
);
CREATE TABLE public.client_supplier_approval_members (
 revision_id uuid NOT NULL REFERENCES public.client_supplier_approval_revisions(id) ON DELETE RESTRICT,
 supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 PRIMARY KEY(revision_id,supplier_id)
);
CREATE TRIGGER client_supplier_approval_scopes_immutable_855 BEFORE UPDATE OR DELETE ON public.client_supplier_approval_scopes
 FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER client_supplier_approval_revisions_immutable_855 BEFORE UPDATE OR DELETE ON public.client_supplier_approval_revisions
 FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER client_supplier_approval_members_immutable_855 BEFORE UPDATE OR DELETE ON public.client_supplier_approval_members
 FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
-- Membership is created in the revision transaction and cannot grow later.
CREATE FUNCTION public.guard_client_approval_member_insert_855() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.client_supplier_approval_revisions r WHERE r.id=NEW.revision_id AND r.created_txid=txid_current())
 THEN RAISE EXCEPTION 'CLIENT_APPROVAL_REVISION_SEALED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER client_supplier_approval_members_sealed_855 BEFORE INSERT ON public.client_supplier_approval_members
 FOR EACH ROW EXECUTE FUNCTION public.guard_client_approval_member_insert_855();
GRANT SELECT,INSERT ON public.client_supplier_approval_scopes,public.client_supplier_approval_revisions,public.client_supplier_approval_members TO cerp_app;
