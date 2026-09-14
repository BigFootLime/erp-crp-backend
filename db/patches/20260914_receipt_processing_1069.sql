-- #1069. Additive receipt processing; quantities are recorded in receipt units.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS commercial_scope text
  CHECK (commercial_scope IN ('CLIENTS', 'CRP'));
CREATE TABLE IF NOT EXISTS public.article_client_links (
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id),
  PRIMARY KEY(article_id, client_id)
);
CREATE INDEX IF NOT EXISTS article_client_links_client_idx ON public.article_client_links(client_id, article_id);
CREATE TABLE IF NOT EXISTS public.article_tool_links (
  article_id uuid PRIMARY KEY REFERENCES public.articles(id) ON DELETE RESTRICT,
  tool_id integer NOT NULL UNIQUE REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.article_receipt_mp_links (
  article_id uuid PRIMARY KEY REFERENCES public.articles(id) ON DELETE RESTRICT,
  stock_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES public.users(id)
);

ALTER TABLE public.commande_fournisseur_ligne ADD COLUMN IF NOT EXISTS receipt_processing_policy text
  CHECK(receipt_processing_policy IN ('STANDARD', 'PIECES_CONTROLE_EMBALLAGE'));
ALTER TABLE public.commande_fournisseur_ligne ADD COLUMN IF NOT EXISTS receipt_tool_id integer REFERENCES public.gestion_outils_outil(id_outil);
ALTER TABLE public.reception_fournisseur_lignes
  ADD COLUMN IF NOT EXISTS processing_policy text NOT NULL DEFAULT 'STANDARD'
    CHECK(processing_policy IN ('STANDARD', 'PIECES_CONTROLE_EMBALLAGE')),
  ADD COLUMN IF NOT EXISTS stock_article_id uuid REFERENCES public.articles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS processing_reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processing_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.reception_fournisseur_lignes ADD COLUMN IF NOT EXISTS receipt_tool_id integer REFERENCES public.gestion_outils_outil(id_outil);

CREATE TABLE IF NOT EXISTS public.reception_packaging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES public.reception_fournisseur_lignes(id) ON DELETE RESTRICT,
  quantity numeric(18,6) NOT NULL CHECK(quantity > 0),
  packaging text NOT NULL CHECK(length(trim(packaging)) BETWEEN 1 AND 200),
  package_count integer NOT NULL CHECK(package_count > 0),
  quality_control_id uuid NOT NULL REFERENCES public.quality_control(id) ON DELETE RESTRICT,
  quality_release_ids jsonb NOT NULL DEFAULT '[]',
  notes text,
  voided_at timestamptz,
  voided_by integer REFERENCES public.users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason)) >= 3))
);
CREATE INDEX IF NOT EXISTS reception_packaging_line_idx ON public.reception_packaging(receipt_line_id);

-- A physical stock sub-lot is explicitly allocated from accepted, packed pieces.
CREATE TABLE IF NOT EXISTS public.reception_stock_portions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES public.reception_fournisseur_lignes(id) ON DELETE RESTRICT,
  packaging_id uuid NOT NULL REFERENCES public.reception_packaging(id) ON DELETE RESTRICT,
  source_lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  stock_lot_id uuid NOT NULL UNIQUE REFERENCES public.lots(id) ON DELETE RESTRICT,
  stock_movement_id uuid NOT NULL REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  quantity numeric(18,6) NOT NULL CHECK(quantity > 0),
  stock_quantity numeric(18,6) NOT NULL CHECK(stock_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id)
);
ALTER TABLE public.reception_stock_portions ADD COLUMN IF NOT EXISTS receipt_stock_offset numeric(18,6) NOT NULL DEFAULT 0 CHECK(receipt_stock_offset>=0);
ALTER TABLE public.of_material_receipt_transfers ADD COLUMN IF NOT EXISTS stock_portion_id uuid REFERENCES public.reception_stock_portions(id);
ALTER TABLE public.of_material_receipt_transfers DROP CONSTRAINT IF EXISTS of_material_receipt_transfers_receipt_id_purchase_need_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS of_material_receipt_transfer_portion_1069 ON public.of_material_receipt_transfers(receipt_id,purchase_need_id,COALESCE(stock_portion_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS reception_stock_portions_line_idx ON public.reception_stock_portions(receipt_line_id);
CREATE INDEX IF NOT EXISTS reception_stock_portions_movement_idx ON public.reception_stock_portions(stock_movement_id);
CREATE TABLE IF NOT EXISTS public.reception_processing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES public.reception_fournisseur_lignes(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  details jsonb NOT NULL,
  actor_id integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.reception_tool_stock_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES public.reception_fournisseur_lignes(id) ON DELETE RESTRICT,
  tool_id integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  tool_movement_id integer NOT NULL UNIQUE REFERENCES public.gestion_outils_mouvement_stock(id_mouvement) ON DELETE RESTRICT,
  quantity numeric(18,6) NOT NULL CHECK(quantity > 0),
  stock_quantity integer NOT NULL CHECK(stock_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id)
);

-- Historical client association is copied only when its FK is unambiguous.
CREATE TABLE IF NOT EXISTS public.reception_subcontract_origins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 receipt_line_id uuid NOT NULL REFERENCES public.reception_fournisseur_lignes(id),
 package_id uuid NOT NULL REFERENCES public.subcontract_work_packages(id),
 return_event_id uuid NOT NULL REFERENCES public.subcontract_work_package_ledger(id),
 issue_event_id uuid NOT NULL REFERENCES public.subcontract_work_package_ledger(id),
 quantity numeric(18,6) NOT NULL CHECK(quantity>0),
 created_by integer NOT NULL REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(receipt_line_id,issue_event_id)
);
ALTER TABLE public.reception_subcontract_origins OWNER TO cerp_app;
INSERT INTO public.article_client_links(article_id, client_id)
SELECT a.id,p.client_id FROM public.articles a JOIN public.pieces_techniques p ON p.id=a.piece_technique_id
JOIN public.clients c ON c.client_id=p.client_id
WHERE a.article_category='fabrique' AND a.commercial_scope IS NULL
ON CONFLICT DO NOTHING;
UPDATE public.articles a SET commercial_scope='CLIENTS'
WHERE a.commercial_scope IS NULL AND EXISTS(SELECT 1 FROM public.article_client_links c WHERE c.article_id=a.id);

CREATE OR REPLACE FUNCTION public.receipt_piece_policy_1069(article uuid, order_type text DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code='consommable')
    OR EXISTS(SELECT 1 FROM public.article_tool_links t WHERE t.article_id=a.id) THEN 'STANDARD'
    WHEN a.article_category IN ('fabrique','achat') OR order_type='SOUS_TRAITANCE'
      OR EXISTS(SELECT 1 FROM public.article_receipt_mp_links p WHERE p.article_id=a.id)
      OR EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code IN ('piece_finie_fabriquee','sous_traitance','achat_revente'))
    THEN 'PIECES_CONTROLE_EMBALLAGE' ELSE 'STANDARD' END FROM public.articles a WHERE a.id=article
$$;

CREATE OR REPLACE FUNCTION public.freeze_receipt_policy_1069() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy text; category text; target uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.receipt_tool_id:=COALESCE((SELECT receipt_tool_id FROM public.commande_fournisseur_ligne WHERE id=NEW.commande_fournisseur_ligne_id),
      (SELECT tool_id FROM public.article_tool_links WHERE article_id=NEW.article_id));
    SELECT COALESCE(l.receipt_processing_policy,public.receipt_piece_policy_1069(NEW.article_id,l.type)) INTO policy
      FROM public.commande_fournisseur_ligne l WHERE l.id=NEW.commande_fournisseur_ligne_id;
    NEW.processing_policy:=COALESCE(policy,public.receipt_piece_policy_1069(NEW.article_id,NULL),'STANDARD');
    SELECT a.article_category,m.stock_article_id INTO category,target FROM public.articles a
      LEFT JOIN public.article_receipt_mp_links m ON m.article_id=a.id WHERE a.id=NEW.article_id;
    IF NEW.processing_policy='PIECES_CONTROLE_EMBALLAGE' THEN
      NEW.stock_article_id:=CASE WHEN category='matiere' THEN NEW.article_id ELSE target END;
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.processing_policy='PIECES_CONTROLE_EMBALLAGE' THEN
    NEW.processing_policy:=OLD.processing_policy;
    NEW.receipt_tool_id:=OLD.receipt_tool_id;
    IF (NEW.article_id,NEW.lot_id,NEW.unite,NEW.stock_unit,NEW.stock_conversion_coef,NEW.qty_received)
      IS DISTINCT FROM (OLD.article_id,OLD.lot_id,OLD.unite,OLD.stock_unit,OLD.stock_conversion_coef,OLD.qty_received)
      AND EXISTS(SELECT 1 FROM public.reception_packaging WHERE receipt_line_id=OLD.id AND voided_at IS NULL) THEN
      RAISE EXCEPTION 'RECEIPT_PROCESSING_LOCKED: correct validated portions using an audited operation' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.processing_policy='PIECES_CONTROLE_EMBALLAGE' THEN NEW.receipt_quality_required:=true; NEW.stock_managed:=true; END IF;
  IF NEW.receipt_tool_id IS NOT NULL THEN NEW.stock_managed:=false; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS freeze_receipt_policy_1069 ON public.reception_fournisseur_lignes;
CREATE TRIGGER freeze_receipt_policy_1069 BEFORE INSERT OR UPDATE ON public.reception_fournisseur_lignes
FOR EACH ROW EXECUTE FUNCTION public.freeze_receipt_policy_1069();

CREATE OR REPLACE FUNCTION public.freeze_purchase_receipt_policy_1069() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.article_id IS DISTINCT FROM OLD.article_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.receipt_processing_policy IS NULL THEN
    NEW.receipt_processing_policy:=COALESCE(public.receipt_piece_policy_1069(NEW.article_id,NEW.type),'STANDARD');
    NEW.receipt_tool_id:=(SELECT tool_id FROM public.article_tool_links WHERE article_id=NEW.article_id);
  END IF;
  IF TG_OP='UPDATE' AND OLD.receipt_processing_policy IS NOT NULL AND NEW.article_id IS NOT DISTINCT FROM OLD.article_id AND NEW.type IS NOT DISTINCT FROM OLD.type THEN NEW.receipt_processing_policy:=OLD.receipt_processing_policy; NEW.receipt_tool_id:=OLD.receipt_tool_id; END IF;
  IF NEW.receipt_processing_policy='PIECES_CONTROLE_EMBALLAGE' THEN NEW.receipt_quality_required:=true; NEW.receipt_stock_managed:=true; END IF;
  IF NEW.receipt_tool_id IS NOT NULL THEN NEW.receipt_stock_managed:=false; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS freeze_purchase_receipt_policy_1069 ON public.commande_fournisseur_ligne;
CREATE TRIGGER freeze_purchase_receipt_policy_1069 BEFORE INSERT OR UPDATE ON public.commande_fournisseur_ligne
FOR EACH ROW EXECUTE FUNCTION public.freeze_purchase_receipt_policy_1069();

UPDATE public.commande_fournisseur_ligne SET receipt_processing_policy=public.receipt_piece_policy_1069(article_id,type)
WHERE receipt_processing_policy IS NULL;

CREATE OR REPLACE VIEW public.receipt_processing_dispositions_1069 AS
SELECT r.id AS receipt_line_id,
 COALESCE(sum(d.qty/COALESCE(r.stock_conversion_coef,1)) FILTER(WHERE nc.status='CLOSED' AND d.disposition_type IN ('SCRAP','RETURN_SUPPLIER')
 AND d.stock_movement_id IS NULL AND upper(trim(d.unite))=upper(trim(r.stock_unit))),0) AS disposed,
 count(DISTINCT nc.id) FILTER(WHERE nc.status::text NOT IN ('CLOSED','CANCELLED')) AS open_nc
FROM public.reception_fournisseur_lignes r
LEFT JOIN public.non_conformity nc ON nc.reception_ligne_id=r.id OR nc.control_id IN(SELECT q.id FROM public.quality_control q WHERE q.reception_ligne_id=r.id)
LEFT JOIN public.non_conformity_dispositions d ON d.non_conformity_id=nc.id
GROUP BY r.id;
ALTER VIEW public.receipt_processing_dispositions_1069 OWNER TO cerp_app;

CREATE OR REPLACE VIEW public.receipt_processing_overview_1069 AS
SELECT l.id,l.reception_id,r.reception_no AS reception_number,r.reception_date,r.status AS receipt_status,
  a.code AS article_code,COALESCE(l.designation,a.designation) AS designation,COALESCE(f.nom,f.raison_sociale,'') AS supplier_name,c.code AS order_code,
  l.processing_reconciliation_required AS reconciliation_required,lot.lot_status,l.qty_received AS received,
  CASE WHEN lot.lot_status='LIBERE' AND qc.validation_date IS NOT NULL THEN LEAST(l.qty_received,COALESCE(qc.qty_released,0)/COALESCE(l.stock_conversion_coef,1)) ELSE 0 END AS accepted,
  COALESCE((SELECT sum(quantity) FROM public.reception_packaging p WHERE p.receipt_line_id=l.id AND p.voided_at IS NULL),0) AS packed,
  COALESCE((SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=l.id AND m.status='POSTED'),0) AS stocked
FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
JOIN public.articles a ON a.id=l.article_id LEFT JOIN public.lots lot ON lot.id=l.lot_id
LEFT JOIN public.fournisseurs f ON f.id=r.fournisseur_id LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id
LEFT JOIN public.commande_fournisseur c ON c.id=cl.commande_id
LEFT JOIN LATERAL(SELECT q.* FROM public.quality_control q WHERE q.lot_id=l.lot_id ORDER BY q.control_date DESC,q.id DESC LIMIT 1) qc ON true
WHERE l.processing_policy='PIECES_CONTROLE_EMBALLAGE';

CREATE OR REPLACE VIEW public.receipt_processing_queue_1069 AS
SELECT l.id,l.reception_id,r.reception_no AS reception_number,r.reception_date,r.status AS receipt_status,
 a.code AS article_code,COALESCE(l.designation,a.designation) AS designation,COALESCE(f.nom,f.raison_sociale,'') AS supplier_name,c.code AS order_code,
 l.processing_policy AS policy,l.stock_managed,l.receipt_tool_id,lot.lot_code,l.processing_reconciliation_required AS reconciliation_required,lot.lot_status,
 l.qty_received AS received,
 CASE WHEN NOT l.receipt_quality_required THEN l.qty_received WHEN lot.lot_status='LIBERE' AND qc.validation_date IS NOT NULL
   THEN LEAST(l.qty_received,COALESCE(qc.qty_released,0)/COALESCE(l.stock_conversion_coef,1)) ELSE 0 END AS accepted,
 COALESCE((SELECT sum(quantity) FROM public.reception_packaging p WHERE p.receipt_line_id=l.id AND p.voided_at IS NULL),0) AS packed,
 COALESCE((SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=l.id AND m.status='POSTED'),0)
 +COALESCE((SELECT sum(s.quantity) FROM public.reception_tool_stock_receipts s WHERE s.receipt_line_id=l.id),0) AS stocked
FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
JOIN public.articles a ON a.id=l.article_id LEFT JOIN public.lots lot ON lot.id=l.lot_id
LEFT JOIN public.fournisseurs f ON f.id=r.fournisseur_id LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id
LEFT JOIN public.commande_fournisseur c ON c.id=cl.commande_id
LEFT JOIN LATERAL(SELECT q.* FROM public.quality_control q WHERE q.lot_id=l.lot_id ORDER BY q.control_date DESC,q.id DESC LIMIT 1) qc ON true;

-- In-progress historical receipts require a reasoned reconciliation. Already
-- posted entries remain immutable; this migration never invents packing proof.
UPDATE public.reception_fournisseur_lignes l SET processing_policy='PIECES_CONTROLE_EMBALLAGE',
  receipt_quality_required=true, stock_managed=true, processing_reconciliation_required=true,
  stock_article_id=CASE WHEN a.article_category='matiere' THEN a.id ELSE m.stock_article_id END
FROM public.receptions_fournisseurs r, public.articles a
LEFT JOIN public.article_receipt_mp_links m ON m.article_id=a.id
WHERE l.reception_id=r.id AND r.status='OPEN' AND l.article_id=a.id
  AND public.receipt_piece_policy_1069(a.id,(SELECT type FROM public.commande_fournisseur_ligne WHERE id=l.commande_fournisseur_ligne_id))='PIECES_CONTROLE_EMBALLAGE'
  AND l.processing_policy='STANDARD';

-- Final database boundary: alternative HTTP routes or inventory writers cannot
-- admit received pieces using the original lot, nor invent a second entry.
CREATE OR REPLACE FUNCTION public.guard_piece_stock_entry_1069() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; portion record;
BEGIN
  IF NEW.status <> 'POSTED' OR (TG_OP='UPDATE' AND OLD.status='POSTED') THEN RETURN NEW; END IF;
  FOR item IN SELECT * FROM public.stock_movement_lines WHERE movement_id=NEW.id LOOP
    IF NEW.movement_type::text NOT IN ('IN','ADJUSTMENT') OR item.qty<=0 THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.article_tool_links WHERE article_id=item.article_id) THEN RAISE EXCEPTION 'TOOL_ARTICLE_STOCK_FORBIDDEN' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes r WHERE r.lot_id=item.lot_id AND r.processing_policy='PIECES_CONTROLE_EMBALLAGE') THEN
      RAISE EXCEPTION 'RECEIPT_PACKAGING_REQUIRED: use the validated packaging stock entry' USING ERRCODE='23514';
    END IF;
    SELECT p.*,l.stock_article_id,l.processing_reconciliation_required,k.voided_at INTO portion
    FROM public.reception_stock_portions p JOIN public.reception_fournisseur_lignes l ON l.id=p.receipt_line_id
    JOIN public.reception_packaging k ON k.id=p.packaging_id WHERE p.stock_lot_id=item.lot_id FOR UPDATE OF l,k;
    IF FOUND AND (portion.stock_movement_id<>NEW.id OR portion.stock_article_id<>item.article_id
      OR portion.stock_quantity<>item.qty OR portion.voided_at IS NOT NULL OR portion.processing_reconciliation_required
      OR NOT EXISTS(SELECT 1 FROM public.articles a WHERE a.id=item.article_id AND a.article_category='matiere')) THEN
      RAISE EXCEPTION 'RECEIPT_STOCK_PORTION_INVALID: validated packaging and MP destination required' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stock_piece_entry_1069 ON public.stock_movements;
CREATE TRIGGER stock_piece_entry_1069 BEFORE INSERT OR UPDATE OF status ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.guard_piece_stock_entry_1069();

-- Inventory imports may insert the posted header before its lines. A deferred
-- line constraint checks the final transaction image, including packed portions.
CREATE OR REPLACE FUNCTION public.guard_piece_stock_line_1069() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record; p record; accepted numeric;
BEGIN
  IF TG_OP='UPDATE' AND NEW.qty IS NOT DISTINCT FROM OLD.qty AND NEW.article_id IS NOT DISTINCT FROM OLD.article_id
    AND NEW.lot_id IS NOT DISTINCT FROM OLD.lot_id AND NEW.movement_id IS NOT DISTINCT FROM OLD.movement_id THEN RETURN NEW; END IF;
  SELECT * INTO m FROM public.stock_movements WHERE id=NEW.movement_id;
  IF m.status<>'POSTED' OR m.movement_type::text NOT IN ('IN','ADJUSTMENT') OR NEW.qty<=0 THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.article_tool_links WHERE article_id=NEW.article_id) THEN RAISE EXCEPTION 'TOOL_ARTICLE_STOCK_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes r WHERE r.lot_id=NEW.lot_id AND r.processing_policy='PIECES_CONTROLE_EMBALLAGE') THEN
    RAISE EXCEPTION 'RECEIPT_PACKAGING_REQUIRED: original received lot cannot be stocked' USING ERRCODE='23514';
  END IF;
  SELECT s.*,r.qty_received,r.stock_article_id,r.stock_conversion_coef,r.processing_reconciliation_required,k.quantity AS packed,k.voided_at,lot.lot_status
    INTO p FROM public.reception_stock_portions s JOIN public.reception_fournisseur_lignes r ON r.id=s.receipt_line_id
    JOIN public.reception_packaging k ON k.id=s.packaging_id JOIN public.lots lot ON lot.id=s.source_lot_id
    WHERE s.stock_lot_id=NEW.lot_id FOR UPDATE OF r,k;
  IF FOUND THEN
    SELECT CASE WHEN q.validation_date IS NOT NULL AND q.trigger_type='RECEPTION' AND q.reception_ligne_id=p.receipt_line_id
      THEN q.qty_released ELSE 0 END INTO accepted FROM public.quality_control q WHERE q.lot_id=p.source_lot_id ORDER BY q.control_date DESC,q.id DESC LIMIT 1;
    IF p.stock_movement_id<>m.id OR p.stock_article_id<>NEW.article_id OR p.stock_quantity<>NEW.qty OR p.lot_status<>'LIBERE'
      OR p.voided_at IS NOT NULL OR p.processing_reconciliation_required
      OR NOT EXISTS(SELECT 1 FROM public.articles a WHERE a.id=NEW.article_id AND a.article_category='matiere')
      OR (SELECT sum(s.stock_quantity) FROM public.reception_stock_portions s JOIN public.stock_movements sm ON sm.id=s.stock_movement_id WHERE s.receipt_line_id=p.receipt_line_id AND sm.status='POSTED') > COALESCE(accepted,0)
      OR (SELECT sum(s.quantity) FROM public.reception_stock_portions s JOIN public.stock_movements sm ON sm.id=s.stock_movement_id WHERE s.packaging_id=p.packaging_id AND sm.status='POSTED')>p.packed
      OR (SELECT sum(k.quantity) FROM public.reception_packaging k WHERE k.receipt_line_id=p.receipt_line_id AND k.voided_at IS NULL)>p.qty_received THEN
      RAISE EXCEPTION 'RECEIPT_STOCK_PORTION_INVALID: quantity, quality, packaging or MP destination mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stock_piece_line_1069 ON public.stock_movement_lines;
CREATE CONSTRAINT TRIGGER stock_piece_line_1069 AFTER INSERT OR UPDATE ON public.stock_movement_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_piece_stock_line_1069();

-- Deferred consistency permits a single transaction to change mode and links.
CREATE OR REPLACE FUNCTION public.guard_article_commercial_1069() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE aid uuid; a record; clients integer;
BEGIN
  IF TG_TABLE_NAME='articles' THEN aid:=NEW.id; ELSE aid:=COALESCE(NEW.article_id,OLD.article_id); END IF;
  SELECT * INTO a FROM public.articles WHERE id=aid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO clients FROM public.article_client_links WHERE article_id=aid;
  IF (a.commercial_scope='CRP' AND (clients<>0 OR COALESCE(length(trim(a.internal_reference)),0)=0))
    OR (a.commercial_scope='CLIENTS' AND clients=0)
    OR (a.commercial_scope IS NULL AND clients>0) THEN
    RAISE EXCEPTION 'ARTICLE_COMMERCIAL_INCONSISTENT: CRP requires an internal reference and no clients; CLIENTS requires at least one client' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS article_commercial_1069 ON public.articles;
CREATE CONSTRAINT TRIGGER article_commercial_1069 AFTER INSERT OR UPDATE ON public.articles
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_article_commercial_1069();
DROP TRIGGER IF EXISTS article_clients_1069 ON public.article_client_links;
CREATE CONSTRAINT TRIGGER article_clients_1069 AFTER INSERT OR UPDATE OR DELETE ON public.article_client_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_article_commercial_1069();

ALTER TABLE public.article_client_links OWNER TO cerp_app;
ALTER TABLE public.article_tool_links OWNER TO cerp_app;
ALTER TABLE public.article_receipt_mp_links OWNER TO cerp_app;
ALTER TABLE public.reception_packaging OWNER TO cerp_app;
ALTER TABLE public.reception_stock_portions OWNER TO cerp_app;
ALTER TABLE public.reception_processing_events OWNER TO cerp_app;
ALTER TABLE public.reception_tool_stock_receipts OWNER TO cerp_app;
ALTER VIEW public.receipt_processing_overview_1069 OWNER TO cerp_app;
ALTER VIEW public.receipt_processing_queue_1069 OWNER TO cerp_app;
-- Views execute with their owner's privileges, including on restored schemas
-- where legacy tables can have a different owner.
GRANT SELECT ON public.reception_fournisseur_lignes,public.receptions_fournisseurs,public.articles,
 public.lots,public.fournisseurs,public.commande_fournisseur_ligne,public.commande_fournisseur,
 public.quality_control,public.reception_fournisseur_stock_receipts,public.stock_movements,
 public.non_conformity,public.non_conformity_dispositions TO cerp_app;
COMMIT;
