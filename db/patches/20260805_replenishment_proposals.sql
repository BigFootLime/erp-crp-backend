-- FEAT-CERP-0003 -- Explainable, human-validated replenishment proposals.
-- Exact, runner-owned migration: pre-existing target artifacts are rejected so
-- every object removed by the guarded dev/test rollback has unambiguous provenance.

BEGIN;

DO $preexisting_guard$
DECLARE
  target_column_count integer;
  target_constraint_count integer;
  target_index_count integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: migration registry is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260805_replenishment_proposals.sql'
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: migration ledger already exists; use the patch runner';
  END IF;

  IF to_regclass('public.stock_levels') IS NULL
     OR to_regclass('public.articles') IS NULL
     OR to_regclass('public.units') IS NULL
     OR to_regclass('public.magasins') IS NULL
     OR to_regclass('public.fournisseurs') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.commande_fournisseur') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne_besoin') IS NULL
     OR to_regclass('public.reception_fournisseur_lignes') IS NULL
     OR to_regclass('public.app_modules') IS NULL
     OR to_regprocedure('public.tg_set_updated_at()') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: prerequisite table, function, or role is missing';
  END IF;

  IF to_regclass('public.replenishment_budgets') IS NOT NULL
     OR to_regclass('public.replenishment_proposals') IS NOT NULL
     OR to_regclass('public.replenishment_proposal_events') IS NOT NULL
     OR to_regclass('public.replenishment_proposal_idempotence') IS NOT NULL
     OR to_regprocedure('public.fn_replenishment_event_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: target table or function already exists without ledger provenance';
  END IF;

  SELECT COUNT(*)::integer INTO target_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'stock_levels' AND column_name IN ('safety_stock_qty','target_stock_qty','order_lot_size'))
      OR (table_name = 'fournisseur_catalogue' AND column_name IN ('unite_stock','coef_conversion','lot_achat'))
      OR (table_name = 'commande_fournisseur' AND column_name = 'replenishment_proposal_id')
    );
  IF target_column_count <> 0 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: target column already exists without ledger provenance';
  END IF;

  SELECT COUNT(*)::integer INTO target_constraint_count
  FROM pg_constraint
  WHERE conname = ANY (ARRAY[
    'stock_levels_replenishment_qty_chk',
    'fournisseur_catalogue_conversion_chk',
    'commande_fournisseur_replenishment_fkey',
    'replenishment_budgets_pkey','replenishment_budgets_magasin_id_fkey',
    'replenishment_budgets_values_chk','replenishment_budgets_scope_uniq',
    'replenishment_proposals_pkey','replenishment_proposals_article_id_fkey',
    'replenishment_proposals_magasin_id_fkey','replenishment_proposals_selected_catalogue_id_fkey',
    'replenishment_proposals_selected_supplier_id_fkey',
    'replenishment_proposals_commande_fournisseur_id_fkey',
    'replenishment_proposals_commande_fournisseur_ligne_id_fkey',
    'replenishment_proposals_status_chk','replenishment_proposals_budget_chk',
    'replenishment_proposals_values_chk','replenishment_proposal_events_pkey',
    'replenishment_proposal_events_proposal_id_fkey','replenishment_proposal_idempotence_pkey',
    'replenishment_proposal_idempotence_proposal_id_fkey','replenishment_proposal_idem_uniq',
    'replenishment_proposal_idem_key_chk','replenishment_proposal_idem_hash_chk'
  ]);
  IF target_constraint_count <> 0 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: target constraint name already exists without ledger provenance';
  END IF;

  SELECT COUNT(*)::integer INTO target_index_count
  FROM pg_class
  WHERE relkind = 'i'
    AND relname = ANY (ARRAY[
      'commande_fournisseur_replenishment_idx',
      'replenishment_budgets_pkey','replenishment_budgets_scope_uniq',
      'replenishment_proposals_pkey',
      'replenishment_proposals_status_idx',
      'replenishment_proposals_article_site_uniq',
      'replenishment_proposals_article_unmapped_uniq',
      'replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_idx',
      'replenishment_proposal_idempotence_pkey','replenishment_proposal_idem_uniq'
    ]);
  IF target_index_count <> 0 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: target index name already exists without ledger provenance';
  END IF;

  IF (SELECT COUNT(*) FROM public.app_modules WHERE module_key = 'commandes-fournisseurs') <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: commandes-fournisseurs module catalogue entry is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.app_modules m, unnest(m.api_prefixes) AS prefix
    WHERE m.module_key = 'commandes-fournisseurs'
      AND prefix = '/replenishment-proposals'
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: module prefix already exists without ledger provenance';
  END IF;
END
$preexisting_guard$;

ALTER TABLE public.stock_levels
  ADD COLUMN safety_stock_qty numeric(18,3),
  ADD COLUMN target_stock_qty numeric(18,3),
  ADD COLUMN order_lot_size numeric(18,3),
  ADD CONSTRAINT stock_levels_replenishment_qty_chk CHECK (
    (safety_stock_qty IS NULL OR safety_stock_qty >= 0)
    AND (target_stock_qty IS NULL OR target_stock_qty >= 0)
    AND (order_lot_size IS NULL OR order_lot_size > 0)
  );

ALTER TABLE public.fournisseur_catalogue
  ADD COLUMN unite_stock text,
  ADD COLUMN coef_conversion numeric(18,6),
  ADD COLUMN lot_achat numeric(18,3),
  ADD CONSTRAINT fournisseur_catalogue_conversion_chk CHECK (
    (coef_conversion IS NULL OR coef_conversion > 0)
    AND (lot_achat IS NULL OR lot_achat > 0)
    AND ((unite_stock IS NULL AND coef_conversion IS NULL) OR (unite_stock IS NOT NULL AND coef_conversion IS NOT NULL))
  );

CREATE TABLE public.replenishment_budgets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  magasin_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'EUR',
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_limit numeric(14,2) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  CONSTRAINT replenishment_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT replenishment_budgets_magasin_id_fkey FOREIGN KEY (magasin_id)
    REFERENCES public.magasins(id) ON DELETE RESTRICT,
  CONSTRAINT replenishment_budgets_values_chk CHECK (
    period_end >= period_start AND amount_limit >= 0 AND char_length(currency) = 3
  ),
  CONSTRAINT replenishment_budgets_scope_uniq UNIQUE (magasin_id, currency, period_start, period_end)
);

CREATE TABLE public.replenishment_proposals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_level_ids uuid[] NOT NULL,
  article_id uuid NOT NULL,
  magasin_id uuid,
  status text NOT NULL DEFAULT 'PROPOSEE',
  version integer NOT NULL DEFAULT 1,
  reason_code text NOT NULL,
  stock_unit text,
  qty_on_hand numeric(18,3) NOT NULL DEFAULT 0,
  qty_reserved numeric(18,3) NOT NULL DEFAULT 0,
  qty_available numeric(18,3) NOT NULL DEFAULT 0,
  qty_open_orders numeric(18,3) NOT NULL DEFAULT 0,
  minimum_stock_qty numeric(18,3),
  safety_stock_qty numeric(18,3),
  target_stock_qty numeric(18,3),
  net_requirement_qty numeric(18,3) NOT NULL DEFAULT 0,
  selected_catalogue_id uuid,
  selected_supplier_id uuid,
  purchase_unit text,
  stock_units_per_purchase_unit numeric(18,6),
  proposed_purchase_qty numeric(18,3),
  proposed_stock_qty numeric(18,3),
  unit_price numeric(14,4),
  currency text,
  estimated_total numeric(14,2),
  budget_status text NOT NULL DEFAULT 'MISSING',
  budget_remaining numeric(14,2),
  missing_data text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  commande_fournisseur_id uuid,
  commande_fournisseur_ligne_id uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  last_recalculated_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  validated_by integer,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_proposals_pkey PRIMARY KEY (id),
  CONSTRAINT replenishment_proposals_article_id_fkey FOREIGN KEY (article_id)
    REFERENCES public.articles(id) ON DELETE RESTRICT,
  CONSTRAINT replenishment_proposals_magasin_id_fkey FOREIGN KEY (magasin_id)
    REFERENCES public.magasins(id) ON DELETE RESTRICT,
  CONSTRAINT replenishment_proposals_selected_catalogue_id_fkey FOREIGN KEY (selected_catalogue_id)
    REFERENCES public.fournisseur_catalogue(id) ON DELETE SET NULL,
  CONSTRAINT replenishment_proposals_selected_supplier_id_fkey FOREIGN KEY (selected_supplier_id)
    REFERENCES public.fournisseurs(id) ON DELETE SET NULL,
  CONSTRAINT replenishment_proposals_commande_fournisseur_id_fkey FOREIGN KEY (commande_fournisseur_id)
    REFERENCES public.commande_fournisseur(id) ON DELETE SET NULL,
  CONSTRAINT replenishment_proposals_commande_fournisseur_ligne_id_fkey FOREIGN KEY (commande_fournisseur_ligne_id)
    REFERENCES public.commande_fournisseur_ligne(id) ON DELETE SET NULL,
  CONSTRAINT replenishment_proposals_status_chk CHECK (status IN ('PROPOSEE','A_COMPLETER','CONVERTIE','RESOLUE')),
  CONSTRAINT replenishment_proposals_budget_chk CHECK (budget_status IN ('OK','EXCEEDED','MISSING','NOT_APPLICABLE')),
  CONSTRAINT replenishment_proposals_values_chk CHECK (
    version > 0 AND cardinality(stock_level_ids) > 0
    AND qty_on_hand >= 0 AND qty_reserved >= 0 AND qty_available >= 0
    AND qty_open_orders >= 0 AND net_requirement_qty >= 0
    AND (stock_units_per_purchase_unit IS NULL OR stock_units_per_purchase_unit > 0)
    AND (proposed_purchase_qty IS NULL OR proposed_purchase_qty > 0)
    AND (proposed_stock_qty IS NULL OR proposed_stock_qty > 0)
    AND (unit_price IS NULL OR unit_price >= 0)
  )
);

CREATE TABLE public.replenishment_proposal_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_proposal_events_pkey PRIMARY KEY (id),
  CONSTRAINT replenishment_proposal_events_proposal_id_fkey FOREIGN KEY (proposal_id)
    REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT
);

CREATE TABLE public.replenishment_proposal_idempotence (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  proposal_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_proposal_idempotence_pkey PRIMARY KEY (id),
  CONSTRAINT replenishment_proposal_idempotence_proposal_id_fkey FOREIGN KEY (proposal_id)
    REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT,
  CONSTRAINT replenishment_proposal_idem_uniq UNIQUE (actor_id, idempotency_key),
  CONSTRAINT replenishment_proposal_idem_key_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT replenishment_proposal_idem_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.commande_fournisseur
  ADD COLUMN replenishment_proposal_id uuid,
  ADD CONSTRAINT commande_fournisseur_replenishment_fkey
    FOREIGN KEY (replenishment_proposal_id)
    REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT;

CREATE INDEX commande_fournisseur_replenishment_idx
  ON public.commande_fournisseur(replenishment_proposal_id)
  WHERE replenishment_proposal_id IS NOT NULL;
CREATE INDEX replenishment_proposals_status_idx
  ON public.replenishment_proposals(status, updated_at DESC);
CREATE UNIQUE INDEX replenishment_proposals_article_site_uniq
  ON public.replenishment_proposals(article_id, magasin_id)
  WHERE magasin_id IS NOT NULL;
CREATE UNIQUE INDEX replenishment_proposals_article_unmapped_uniq
  ON public.replenishment_proposals(article_id)
  WHERE magasin_id IS NULL;
CREATE INDEX replenishment_proposal_events_proposal_idx
  ON public.replenishment_proposal_events(proposal_id, created_at DESC);

CREATE FUNCTION public.fn_replenishment_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
  RAISE EXCEPTION 'Replenishment proposal events are append-only' USING ERRCODE = '55000';
END
$immutable$;

CREATE TRIGGER replenishment_proposal_events_immutable
BEFORE UPDATE OR DELETE ON public.replenishment_proposal_events
FOR EACH ROW EXECUTE FUNCTION public.fn_replenishment_event_immutable();

CREATE TRIGGER replenishment_proposals_set_updated_at
BEFORE UPDATE ON public.replenishment_proposals
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TRIGGER replenishment_budgets_set_updated_at
BEFORE UPDATE ON public.replenishment_budgets
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DO $module_catalog$
DECLARE
  changed_rows integer;
BEGIN
  UPDATE public.app_modules
     SET api_prefixes = array_append(api_prefixes, '/replenishment-proposals'),
         updated_at = now()
   WHERE module_key = 'commandes-fournisseurs'
     AND NOT ('/replenishment-proposals' = ANY(api_prefixes));
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003: module prefix update did not affect exactly one row';
  END IF;
END
$module_catalog$;

ALTER TABLE public.replenishment_budgets OWNER TO cerp_app;
ALTER TABLE public.replenishment_proposals OWNER TO cerp_app;
ALTER TABLE public.replenishment_proposal_events OWNER TO cerp_app;
ALTER TABLE public.replenishment_proposal_idempotence OWNER TO cerp_app;
ALTER FUNCTION public.fn_replenishment_event_immutable() OWNER TO cerp_app;

DO $remove_default_acl_leaks$
DECLARE
  target_relation regclass;
  unexpected_grantee name;
BEGIN
  FOREACH target_relation IN ARRAY ARRAY[
    'public.replenishment_budgets'::regclass,
    'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,
    'public.replenishment_proposal_idempotence'::regclass
  ]
  LOOP
    FOR unexpected_grantee IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_class relation_metadata
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation_metadata.relacl,
        acldefault('r', relation_metadata.relowner)
      )) acl_entry
      JOIN pg_roles grantee_role ON grantee_role.oid = acl_entry.grantee
      WHERE relation_metadata.oid = target_relation
        AND acl_entry.grantee <> relation_metadata.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I CASCADE', target_relation, unexpected_grantee);
    END LOOP;
  END LOOP;

  FOR unexpected_grantee IN
    SELECT DISTINCT grantee_role.rolname
    FROM pg_proc function_metadata
    CROSS JOIN LATERAL aclexplode(COALESCE(
      function_metadata.proacl,
      acldefault('f', function_metadata.proowner)
    )) acl_entry
    JOIN pg_roles grantee_role ON grantee_role.oid = acl_entry.grantee
    WHERE function_metadata.oid = 'public.fn_replenishment_event_immutable()'::regprocedure
      AND acl_entry.grantee <> function_metadata.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.fn_replenishment_event_immutable() FROM %I CASCADE',
      unexpected_grantee
    );
  END LOOP;
END
$remove_default_acl_leaks$;

REVOKE ALL ON TABLE public.replenishment_budgets FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.replenishment_proposals FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.replenishment_proposal_events FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.replenishment_proposal_idempotence FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.replenishment_budgets TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.replenishment_proposals TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.replenishment_proposal_events TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.replenishment_proposal_idempotence TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_replenishment_event_immutable() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_replenishment_event_immutable() TO cerp_app;

COMMENT ON TABLE public.replenishment_proposals IS
  'FEAT-CERP-0003 current explainable proposal, unique per aggregated article/site scope. Validation always recalculates before creating a BCF draft.';
COMMENT ON COLUMN public.replenishment_proposals.stock_level_ids IS
  'Auditable source stock levels aggregated into the unique article/site proposal; order-independent UUID array.';
COMMENT ON COLUMN public.fournisseur_catalogue.coef_conversion IS
  'Number of stock units represented by one supplier purchase unit. Required with unite_stock when units differ.';

COMMIT;
