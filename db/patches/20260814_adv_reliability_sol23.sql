-- SOL-23 - ADV, OTIF, cash, blocages et litiges traçables.
-- Additif et rejouable. Aucun statut de connecteur de facturation électronique n'est simulé.

BEGIN;

CREATE TABLE IF NOT EXISTS public.adv_delivery_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.bon_livraison(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id bigint NOT NULL REFERENCES public.commande_client(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('QUALITY','DOCUMENT','STOCK','TRANSPORT')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  detail text NOT NULL CHECK (char_length(btrim(detail)) BETWEEN 3 AND 1000),
  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  next_action text NOT NULL CHECK (char_length(btrim(next_action)) BETWEEN 3 AND 500),
  due_date date NOT NULL,
  resolution_note text NULL,
  resolved_at timestamptz NULL,
  resolved_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT adv_delivery_blocks_resolution_0455_ck CHECK (
    (status='OPEN' AND resolution_note IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status='RESOLVED' AND char_length(btrim(resolution_note))>=3 AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS adv_delivery_blocks_active_0455_uq
  ON public.adv_delivery_blocks(delivery_id,category) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS adv_delivery_blocks_queue_0455_idx
  ON public.adv_delivery_blocks(status,due_date,order_id);

CREATE TABLE IF NOT EXISTS public.adv_payment_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_ttc numeric(18,2) NOT NULL CHECK (amount_ttc>0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  promised_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','KEPT','BROKEN','CANCELLED')),
  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  next_action text NOT NULL CHECK (char_length(btrim(next_action)) BETWEEN 3 AND 500),
  due_date date NOT NULL,
  note text NULL,
  resolution_note text NULL,
  resolved_at timestamptz NULL,
  resolved_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT adv_payment_promises_resolution_0455_ck CHECK (
    (status='OPEN' AND resolution_note IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status<>'OPEN' AND char_length(btrim(resolution_note))>=3 AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS adv_payment_promises_forecast_0455_idx
  ON public.adv_payment_promises(status,promised_date,facture_id);

CREATE TABLE IF NOT EXISTS public.adv_invoice_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('QUALITY','DOCUMENT','PRICE','QUANTITY','DELIVERY','TAX','OTHER')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
  disputed_amount_ttc numeric(18,2) NULL CHECK (disputed_amount_ttc>0),
  detail text NOT NULL CHECK (char_length(btrim(detail)) BETWEEN 3 AND 1000),
  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  next_action text NOT NULL CHECK (char_length(btrim(next_action)) BETWEEN 3 AND 500),
  due_date date NOT NULL,
  resolution_note text NULL,
  resolved_at timestamptz NULL,
  resolved_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT adv_invoice_disputes_resolution_0455_ck CHECK (
    (status='OPEN' AND resolution_note IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status<>'OPEN' AND char_length(btrim(resolution_note))>=3 AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS adv_invoice_disputes_queue_0455_idx
  ON public.adv_invoice_disputes(status,due_date,facture_id);

CREATE TABLE IF NOT EXISTS public.adv_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type text NOT NULL CHECK (case_type IN ('DELIVERY_BLOCK','PAYMENT_PROMISE','INVOICE_DISPUTE')),
  case_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 2 AND 40),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adv_case_events_lookup_0455_idx ON public.adv_case_events(case_type,case_id,created_at,id);

CREATE TABLE IF NOT EXISTS public.adv_otif_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id bigint NOT NULL UNIQUE REFERENCES public.commande_client(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  promised_date date NOT NULL,
  completion_date date NOT NULL,
  on_time_in_full boolean NOT NULL,
  source text NOT NULL DEFAULT 'FULFILMENT_TRIGGER' CHECK (source='FULFILMENT_TRIGGER'),
  line_snapshot jsonb NOT NULL CHECK (jsonb_typeof(line_snapshot)='array'),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS adv_otif_assessments_period_0455_idx ON public.adv_otif_assessments(promised_date,on_time_in_full);

CREATE TABLE IF NOT EXISTS public.adv_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('DELIVERY_BLOCK_CREATE','DELIVERY_BLOCK_RESOLVE','PAYMENT_PROMISE_CREATE','PAYMENT_PROMISE_STATUS','INVOICE_DISPUTE_CREATE','INVOICE_DISPUTE_STATUS')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  response_snapshot jsonb NOT NULL CHECK (jsonb_typeof(response_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_command_receipts_action_key_0455_uq UNIQUE(action,idempotency_key)
);

CREATE OR REPLACE FUNCTION public.adv_case_transition_guard_0455()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% cases cannot be deleted',TG_TABLE_NAME; END IF;
  IF OLD.status<>'OPEN' THEN RAISE EXCEPTION '% is already closed',TG_TABLE_NAME; END IF;
  IF NEW.status='OPEN' THEN RAISE EXCEPTION '% updates must close the case',TG_TABLE_NAME; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','resolution_note','resolved_at','resolved_by','version','updated_at','updated_by']::text[])
     <> (to_jsonb(OLD)-ARRAY['status','resolution_note','resolved_at','resolved_by','version','updated_at','updated_by']::text[]) THEN
    RAISE EXCEPTION '% immutable business fields changed',TG_TABLE_NAME;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION '% version must increment exactly once',TG_TABLE_NAME; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_adv_delivery_blocks_transition_0455 ON public.adv_delivery_blocks;
CREATE TRIGGER trg_adv_delivery_blocks_transition_0455 BEFORE UPDATE OR DELETE ON public.adv_delivery_blocks
  FOR EACH ROW EXECUTE FUNCTION public.adv_case_transition_guard_0455();
DROP TRIGGER IF EXISTS trg_adv_payment_promises_transition_0455 ON public.adv_payment_promises;
CREATE TRIGGER trg_adv_payment_promises_transition_0455 BEFORE UPDATE OR DELETE ON public.adv_payment_promises
  FOR EACH ROW EXECUTE FUNCTION public.adv_case_transition_guard_0455();
DROP TRIGGER IF EXISTS trg_adv_invoice_disputes_transition_0455 ON public.adv_invoice_disputes;
CREATE TRIGGER trg_adv_invoice_disputes_transition_0455 BEFORE UPDATE OR DELETE ON public.adv_invoice_disputes
  FOR EACH ROW EXECUTE FUNCTION public.adv_case_transition_guard_0455();

CREATE OR REPLACE FUNCTION public.adv_append_only_guard_0455()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS trg_adv_case_events_append_only_0455 ON public.adv_case_events;
CREATE TRIGGER trg_adv_case_events_append_only_0455 BEFORE UPDATE OR DELETE ON public.adv_case_events
  FOR EACH ROW EXECUTE FUNCTION public.adv_append_only_guard_0455();
DROP TRIGGER IF EXISTS trg_adv_otif_append_only_0455 ON public.adv_otif_assessments;
CREATE TRIGGER trg_adv_otif_append_only_0455 BEFORE UPDATE OR DELETE ON public.adv_otif_assessments
  FOR EACH ROW EXECUTE FUNCTION public.adv_append_only_guard_0455();
DROP TRIGGER IF EXISTS trg_adv_receipts_append_only_0455 ON public.adv_command_receipts;
CREATE TRIGGER trg_adv_receipts_append_only_0455 BEFORE UPDATE OR DELETE ON public.adv_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.adv_append_only_guard_0455();

CREATE OR REPLACE FUNCTION public.adv_freeze_otif_0455()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_eligible boolean;
  v_complete boolean;
  v_pass boolean;
  v_promised date;
  v_completion date;
  v_lines jsonb;
BEGIN
  IF NEW.commande_id IS NULL OR NEW.statut NOT IN ('SHIPPED','DELIVERED') OR OLD.statut=NEW.statut THEN RETURN NEW; END IF;
  WITH line_facts AS (
    SELECT cl.id,cl.delai_client,cl.quantite,
           COALESCE(SUM(bll.quantite) FILTER(WHERE bl.statut IN ('SHIPPED','DELIVERED')),0) AS shipped_qty,
           MAX(COALESCE(bl.date_expedition,bl.date_livraison,bl.date_creation)) FILTER(WHERE bl.statut IN ('SHIPPED','DELIVERED')) AS completion_date
      FROM public.commande_ligne cl
      LEFT JOIN public.bon_livraison_ligne bll ON bll.commande_ligne_id=cl.id
      LEFT JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id
     WHERE cl.commande_id=NEW.commande_id GROUP BY cl.id,cl.delai_client,cl.quantite
  )
  SELECT BOOL_AND(delai_client IS NOT NULL),BOOL_AND(shipped_qty>=quantite),
         BOOL_AND(completion_date IS NOT NULL AND completion_date<=delai_client),MAX(delai_client),MAX(completion_date),
         jsonb_agg(jsonb_build_object('line_id',id,'promised_date',delai_client,'ordered_qty',quantite,'shipped_qty',shipped_qty,'completion_date',completion_date) ORDER BY id)
    INTO v_eligible,v_complete,v_pass,v_promised,v_completion,v_lines FROM line_facts;
  IF v_eligible AND v_complete THEN
    INSERT INTO public.adv_otif_assessments(order_id,promised_date,completion_date,on_time_in_full,line_snapshot,frozen_by)
    VALUES(NEW.commande_id,v_promised,v_completion,v_pass,v_lines,NEW.updated_by)
    ON CONFLICT(order_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_adv_freeze_otif_0455 ON public.bon_livraison;
CREATE TRIGGER trg_adv_freeze_otif_0455 AFTER UPDATE OF statut ON public.bon_livraison
  FOR EACH ROW EXECUTE FUNCTION public.adv_freeze_otif_0455();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    ALTER TABLE public.adv_delivery_blocks OWNER TO cerp_app;
    ALTER TABLE public.adv_payment_promises OWNER TO cerp_app;
    ALTER TABLE public.adv_invoice_disputes OWNER TO cerp_app;
    ALTER TABLE public.adv_case_events OWNER TO cerp_app;
    ALTER TABLE public.adv_otif_assessments OWNER TO cerp_app;
    ALTER TABLE public.adv_command_receipts OWNER TO cerp_app;
    GRANT SELECT,INSERT,UPDATE ON public.adv_delivery_blocks,public.adv_payment_promises,public.adv_invoice_disputes TO cerp_app;
    GRANT SELECT,INSERT ON public.adv_case_events,public.adv_otif_assessments,public.adv_command_receipts TO cerp_app;
  END IF;
END $$;

COMMENT ON TABLE public.adv_otif_assessments IS 'SOL-23: preuve OTIF figée à la première complétude de la commande; aucune réécriture historique.';
COMMENT ON TABLE public.adv_payment_promises IS 'SOL-23: promesses client explicites; la prévision les plafonne au solde et évite le double comptage des échéances.';

COMMIT;
