-- Additive recording of signed supplier open contracts. Existing POs remain canonical call-offs.
INSERT INTO public.ged_document_classes
 (class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes,approvals_required,retention_months,hold_on_publish,is_active)
VALUES ('CERP_CONTRAT_FOURNISSEUR','COMMERCIAL','Contrat ouvert fournisseur / avenant signé','SOURCE',ARRAY['application/pdf'],ARRAY['pdf'],10485760,1,NULL,true,true)
ON CONFLICT (class_key) DO NOTHING;
CREATE TABLE public.supplier_open_contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 120),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz, closed_by integer REFERENCES public.users(id) ON DELETE RESTRICT, close_reason text,
 CHECK((closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND length(btrim(close_reason)) BETWEEN 3 AND 500)),
 UNIQUE(supplier_id,reference)
);
CREATE TABLE public.supplier_open_contract_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES public.supplier_open_contracts(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0), valid_from date NOT NULL, valid_to date NOT NULL CHECK(valid_to>=valid_from),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 evidence_version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
 evidence_snapshot jsonb NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500), created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), created_txid bigint NOT NULL DEFAULT txid_current(), UNIQUE(contract_id,revision), UNIQUE(contract_id,id)
);
CREATE TABLE public.supplier_open_contract_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES public.supplier_open_contracts(id) ON DELETE RESTRICT,
 revision_id uuid NOT NULL, order_id uuid NOT NULL UNIQUE REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
 technical_sources jsonb NOT NULL CHECK(jsonb_typeof(technical_sources)='array'), documents jsonb NOT NULL CHECK(jsonb_typeof(documents)='array'), order_snapshot jsonb NOT NULL CHECK(jsonb_typeof(order_snapshot)='object'),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), created_txid bigint NOT NULL DEFAULT txid_current(),
 FOREIGN KEY(contract_id,revision_id) REFERENCES public.supplier_open_contract_revisions(contract_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.supplier_open_contract_call_lines (
 call_id uuid NOT NULL REFERENCES public.supplier_open_contract_calls(id) ON DELETE RESTRICT,
 line_id uuid NOT NULL UNIQUE REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
 contract_line_id uuid NOT NULL, quantity numeric(15,3) NOT NULL CHECK(quantity>0), PRIMARY KEY(call_id,line_id)
);
CREATE TABLE public.supplier_open_contract_commands (
 idempotency_key uuid PRIMARY KEY, actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_contract_call_contract_861 ON public.supplier_open_contract_calls(contract_id);
CREATE TRIGGER supplier_open_contract_revisions_immutable_861 BEFORE UPDATE OR DELETE ON public.supplier_open_contract_revisions FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_open_contract_calls_immutable_861 BEFORE UPDATE OR DELETE ON public.supplier_open_contract_calls FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_open_contract_call_lines_immutable_861 BEFORE UPDATE OR DELETE ON public.supplier_open_contract_call_lines FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER supplier_open_contract_commands_immutable_861 BEFORE UPDATE OR DELETE ON public.supplier_open_contract_commands FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE FUNCTION public.guard_supplier_call_line_insert_861() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE call_row public.supplier_open_contract_calls; expected_quantity numeric;
BEGIN
 SELECT * INTO call_row FROM public.supplier_open_contract_calls WHERE id=NEW.call_id;
 IF call_row.created_txid IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'OPEN_CONTRACT_CALL_SEALED' USING ERRCODE='23514'; END IF;
 SELECT quantite-qty_annulee INTO expected_quantity FROM public.commande_fournisseur_ligne WHERE id=NEW.line_id AND commande_id=call_row.order_id AND statut_ligne='ACTIVE';
 IF expected_quantity IS NULL OR expected_quantity<>NEW.quantity THEN RAISE EXCEPTION 'OPEN_CONTRACT_CALL_LINE_INVALID' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.supplier_open_contract_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'items') item WHERE r.id=call_row.revision_id AND item->>'key'=NEW.contract_line_id::text)
 THEN RAISE EXCEPTION 'OPEN_CONTRACT_ENVELOPE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_open_contract_call_lines_sealed_861 BEFORE INSERT ON public.supplier_open_contract_call_lines FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_call_line_insert_861();
-- All write paths, including automatic purchasing drafts, respect the frozen commercial lines.
CREATE FUNCTION public.guard_supplier_call_purchase_line_861() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_key uuid; old_order_key uuid;
BEGIN
 order_key:=CASE WHEN TG_OP='DELETE' THEN OLD.commande_id ELSE NEW.commande_id END;
 IF TG_OP='UPDATE' THEN old_order_key:=OLD.commande_id; END IF;
 IF EXISTS(SELECT 1 FROM public.supplier_open_contract_calls c WHERE c.order_id=order_key OR c.order_id=old_order_key) THEN
  IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['updated_at','qty_confirmee','qty_annulee','date_promesse','delai_jours']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','qty_confirmee','qty_annulee','date_promesse','delai_jours'])
  THEN RAISE EXCEPTION 'OPEN_CONTRACT_CALL_SEALED' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER supplier_contract_purchase_lines_861 BEFORE INSERT OR UPDATE OR DELETE ON public.commande_fournisseur_ligne FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_call_purchase_line_861();
CREATE FUNCTION public.guard_supplier_call_purchase_header_861() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.supplier_open_contract_calls c WHERE c.order_id=OLD.id) AND
  ROW(NEW.fournisseur_id,NEW.devise,NEW.incoterm,NEW.conditions_paiement,NEW.mode_transport,NEW.date_besoin,NEW.frais_port_ht,NEW.tva_frais_pct,NEW.adresse_livraison_texte,NEW.magasin_livraison_id)
  IS DISTINCT FROM ROW(OLD.fournisseur_id,OLD.devise,OLD.incoterm,OLD.conditions_paiement,OLD.mode_transport,OLD.date_besoin,OLD.frais_port_ht,OLD.tva_frais_pct,OLD.adresse_livraison_texte,OLD.magasin_livraison_id)
 THEN RAISE EXCEPTION 'OPEN_CONTRACT_CALL_SEALED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_contract_purchase_header_861 BEFORE UPDATE ON public.commande_fournisseur FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_call_purchase_header_861();
REVOKE UPDATE,DELETE,TRUNCATE ON public.supplier_open_contracts,public.supplier_open_contract_revisions,public.supplier_open_contract_calls,public.supplier_open_contract_call_lines,public.supplier_open_contract_commands FROM cerp_app;
GRANT SELECT,INSERT ON public.supplier_open_contracts,public.supplier_open_contract_revisions,public.supplier_open_contract_calls,public.supplier_open_contract_call_lines,public.supplier_open_contract_commands TO cerp_app;
GRANT UPDATE(closed_at,closed_by,close_reason) ON public.supplier_open_contracts TO cerp_app;
