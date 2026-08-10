-- SOL-05 only: bridge the empty 2026-02 legacy BIGINT stock/delivery schema to
-- the UUID contracts assumed by later additive patches.

BEGIN;

DO $guard$
DECLARE
  relation_name text;
  row_count bigint;
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.e2e_isolated', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SOL-05 UUID normalization refused outside isolated cerp_test';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'articles', 'magasins', 'emplacements', 'lots', 'stock_movements',
    'stock_movement_lines', 'stock_ledger', 'stock_balances',
    'stock_movement_documents', 'article_documents', 'stock_movement_event_log',
    'bon_livraison', 'bon_livraison_ligne', 'bon_livraison_documents',
    'bon_livraison_event_log'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', relation_name) INTO row_count;
      IF row_count <> 0 THEN
        RAISE EXCEPTION 'SOL-05 normalization requires empty %, found % row(s)', relation_name, row_count;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

-- Drop the legacy constraints that pin the BIGINT spine.
ALTER TABLE public.lots DROP CONSTRAINT IF EXISTS lots_article_id_fkey;
ALTER TABLE public.lots DROP CONSTRAINT IF EXISTS lots_id_article_uniq;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_movement_id_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_article_id_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_lot_id_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_lot_article_id_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_lot_article_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_src_magasin_id_fkey;
ALTER TABLE public.stock_movement_lines DROP CONSTRAINT IF EXISTS stock_movement_lines_dst_magasin_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_movement_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_movement_line_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_article_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_magasin_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_lot_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_lot_article_id_fkey;
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_lot_article_fkey;
ALTER TABLE public.stock_balances DROP CONSTRAINT IF EXISTS stock_balances_article_id_fkey;
ALTER TABLE public.stock_balances DROP CONSTRAINT IF EXISTS stock_balances_magasin_id_fkey;
ALTER TABLE public.stock_balances DROP CONSTRAINT IF EXISTS stock_balances_lot_id_fkey;
ALTER TABLE public.stock_balances DROP CONSTRAINT IF EXISTS stock_balances_lot_article_id_fkey;
ALTER TABLE public.stock_balances DROP CONSTRAINT IF EXISTS stock_balances_lot_article_fkey;
ALTER TABLE public.stock_movement_documents DROP CONSTRAINT IF EXISTS stock_movement_documents_stock_movement_id_fkey;
ALTER TABLE public.stock_movement_documents DROP CONSTRAINT IF EXISTS stock_movement_documents_movement_fkey;
ALTER TABLE public.article_documents DROP CONSTRAINT IF EXISTS article_documents_article_id_fkey;
ALTER TABLE public.article_documents DROP CONSTRAINT IF EXISTS article_documents_article_fkey;
ALTER TABLE public.stock_movement_event_log DROP CONSTRAINT IF EXISTS stock_movement_event_log_movement_fkey;
ALTER TABLE public.emplacements DROP CONSTRAINT IF EXISTS emplacements_magasin_id_fkey;
ALTER TABLE public.commande_client DROP CONSTRAINT IF EXISTS commande_client_dest_stock_magasin_id_fkey;
ALTER TABLE public.bon_livraison_ligne DROP CONSTRAINT IF EXISTS bon_livraison_ligne_bon_livraison_id_fkey;
ALTER TABLE public.bon_livraison_documents DROP CONSTRAINT IF EXISTS bon_livraison_documents_bl_id_fkey;
ALTER TABLE public.bon_livraison_event_log DROP CONSTRAINT IF EXISTS bon_livraison_event_log_bl_id_fkey;

ALTER TABLE public.articles ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.articles ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.articles ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE public.magasins ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.magasins ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.magasins ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.magasins
  ADD COLUMN IF NOT EXISTS code_magasin text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS libelle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS actif boolean NOT NULL DEFAULT true;

ALTER TABLE public.emplacements ALTER COLUMN magasin_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.commande_client ALTER COLUMN dest_stock_magasin_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.lots ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.lots ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.lots ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.lots ALTER COLUMN article_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS lot_status text NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS lot_status_note text;

ALTER TABLE public.stock_movements ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.stock_movements ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.stock_movements ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'movement_type') THEN
    CREATE TYPE public.movement_type AS ENUM (
      'IN','OUT','TRANSFER','ADJUST','RESERVE','UNRESERVE','DEPRECIATE','ADJUSTMENT','SCRAP'
    );
  END IF;
END
$$;
ALTER TABLE public.stock_movements
  ALTER COLUMN movement_type TYPE public.movement_type
  USING movement_type::text::public.movement_type;
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS article_id uuid,
  ADD COLUMN IF NOT EXISTS stock_level_id uuid,
  ADD COLUMN IF NOT EXISTS stock_batch_id uuid,
  ADD COLUMN IF NOT EXISTS qty numeric(18,6),
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS user_id integer;

ALTER TABLE public.stock_movement_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.stock_movement_lines ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.stock_movement_lines ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.stock_movement_lines ALTER COLUMN movement_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_movement_lines ALTER COLUMN article_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_movement_lines ALTER COLUMN lot_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_movement_lines ALTER COLUMN src_magasin_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_movement_lines ALTER COLUMN dst_magasin_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.stock_ledger ALTER COLUMN movement_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_ledger ALTER COLUMN movement_line_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_ledger ALTER COLUMN article_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_ledger ALTER COLUMN magasin_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_ledger ALTER COLUMN lot_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.stock_balances ALTER COLUMN article_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_balances ALTER COLUMN magasin_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_balances ALTER COLUMN lot_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.stock_movement_documents ALTER COLUMN stock_movement_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.article_documents ALTER COLUMN article_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.stock_movement_event_log ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.stock_movement_event_log ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.stock_movement_event_log ALTER COLUMN stock_movement_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.bon_livraison ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.bon_livraison ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.bon_livraison ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.bon_livraison_ligne ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.bon_livraison_ligne ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.bon_livraison_ligne ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.bon_livraison_ligne ALTER COLUMN bon_livraison_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.bon_livraison_documents ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.bon_livraison_documents ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE public.bon_livraison_documents ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.bon_livraison_documents ALTER COLUMN bon_livraison_id TYPE uuid USING NULL::uuid;
ALTER TABLE public.bon_livraison_event_log ALTER COLUMN bon_livraison_id TYPE uuid USING NULL::uuid;

-- Rebuild only the constraints needed by later patches; the canonical patches
-- add the remaining UUID-spine constraints and indexes.
ALTER TABLE public.emplacements ADD CONSTRAINT emplacements_magasin_id_fkey
  FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
ALTER TABLE public.lots ADD CONSTRAINT lots_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_movement_id_fkey
  FOREIGN KEY (movement_id) REFERENCES public.stock_movements(id) ON DELETE CASCADE;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_lot_id_fkey
  FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_lot_article_id_fkey
  FOREIGN KEY (lot_id, article_id) REFERENCES public.lots(id, article_id) ON DELETE SET NULL;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_src_magasin_id_fkey
  FOREIGN KEY (src_magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movement_lines ADD CONSTRAINT stock_movement_lines_dst_magasin_id_fkey
  FOREIGN KEY (dst_magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
ALTER TABLE public.commande_client ADD CONSTRAINT commande_client_dest_stock_magasin_id_fkey
  FOREIGN KEY (dest_stock_magasin_id) REFERENCES public.magasins(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.stock_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  managed_in_stock boolean NOT NULL DEFAULT true,
  qty_total numeric(18,3) NOT NULL DEFAULT 0,
  qty_reserved numeric(18,3) NOT NULL DEFAULT 0,
  qty_depreciated numeric(18,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id),
  updated_by integer REFERENCES public.users(id),
  UNIQUE (article_id, location_id)
);

CREATE TABLE IF NOT EXISTS public.stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_level_id uuid NOT NULL REFERENCES public.stock_levels(id) ON DELETE CASCADE,
  batch_code text NOT NULL,
  qty_total numeric(18,3) NOT NULL DEFAULT 0,
  qty_reserved numeric(18,3) NOT NULL DEFAULT 0,
  qty_depreciated numeric(18,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stock_level_id, batch_code)
);

COMMIT;
