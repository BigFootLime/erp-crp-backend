-- #1028: physical lane configuration and a read-only projection of existing stock.
-- No balance, reservation, lot, historical location or production receipt is rewritten.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.v_stock_availability_225') IS NULL
    OR to_regclass('public.of_component_requirements') IS NULL
    OR to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL THEN
    RAISE EXCEPTION '#1028 requires the canonical stock ledger and assembly reservations';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_lane_locations (
  location_id uuid PRIMARY KEY REFERENCES public.locations(id) ON DELETE RESTRICT,
  lane text NOT NULL CHECK (lane IN ('FREE','DELIVERY','ASSEMBLY')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version>0),
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_lane_locations_lane_idx ON public.stock_lane_locations(lane,location_id);

CREATE TABLE IF NOT EXISTS public.stock_lane_configuration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  old_lane text NULL CHECK (old_lane IN ('FREE','DELIVERY','ASSEMBLY')),
  new_lane text NOT NULL CHECK (new_lane IN ('FREE','DELIVERY','ASSEMBLY')),
  old_version integer NOT NULL CHECK (old_version>=0),
  new_version integer NOT NULL CHECK (new_version=old_version+1),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_user_id,request_id)
);
CREATE INDEX IF NOT EXISTS stock_lane_configuration_events_location_idx
  ON public.stock_lane_configuration_events(location_id,created_at,id);
DROP TRIGGER IF EXISTS stock_lane_configuration_events_immutable ON public.stock_lane_configuration_events;
CREATE TRIGGER stock_lane_configuration_events_immutable
  BEFORE UPDATE OR DELETE ON public.stock_lane_configuration_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

CREATE OR REPLACE VIEW public.v_stock_lane_positions_1028 AS
SELECT availability.availability_id AS position_id, availability.stock_level_id,
  availability.stock_batch_id, availability.location_id, role.lane,
  magasin.code AS magasin_code, emplacement.code AS emplacement_code,
  availability.article_id, article.code AS article_code, article.designation,
  unit.code AS unit, availability.lot_id, availability.lot_code, availability.lot_status,
  COALESCE(lot.origin_stock_scope,lot.source_scope,lot.stock_scope,'NEW') AS source_scope,
  availability.qty_on_hand AS physical_qty, availability.qty_reserved AS reserved_qty,
  COALESCE(reservations.delivery_qty,0) AS delivery_reserved_qty,
  COALESCE(reservations.assembly_qty,0) AS assembly_reserved_qty,
  COALESCE(reservations.other_qty,0) AS other_reserved_qty,
  GREATEST(availability.qty_on_hand-availability.qty_reserved-availability.qty_depreciated,0) AS unreserved_qty,
  availability.qty_available AS available_by_lot_status_qty,
  availability.qty_reserved-COALESCE(reservations.total_qty,0) AS unexplained_reserved_qty
FROM public.v_stock_availability_225 availability
JOIN public.articles article ON article.id=availability.article_id
JOIN public.units unit ON unit.id=availability.unit_id
LEFT JOIN public.lots lot ON lot.id=availability.lot_id
LEFT JOIN public.stock_lane_locations role ON role.location_id=availability.location_id
LEFT JOIN public.emplacements emplacement ON emplacement.location_id=availability.location_id
LEFT JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
LEFT JOIN LATERAL (
  SELECT sum(entry.qty) AS total_qty,
    sum(entry.qty) FILTER(WHERE entry.kind='DELIVERY') AS delivery_qty,
    sum(entry.qty) FILTER(WHERE entry.kind='ASSEMBLY') AS assembly_qty,
    sum(entry.qty) FILTER(WHERE entry.kind='OTHER') AS other_qty
  FROM (
    SELECT GREATEST(r.qty_reserved-COALESCE(r.qty_consumed,0),0) AS qty,
      CASE WHEN r.of_component_requirement_id IS NOT NULL THEN 'ASSEMBLY'
        WHEN r.livraison_affaire_id IS NOT NULL
          OR r.source_type IN ('COMMANDE_LIGNE','AFFAIRE','BON_LIVRAISON_LIGNE') THEN 'DELIVERY'
        ELSE 'OTHER' END AS kind
    FROM public.stock_reservations r
    WHERE r.status='ACTIVE' AND r.stock_level_id=availability.stock_level_id
      AND r.stock_batch_id IS NOT DISTINCT FROM availability.stock_batch_id
  ) entry
) reservations ON true
WHERE availability.qty_on_hand<>0 OR availability.qty_reserved<>0;

COMMENT ON TABLE public.stock_lane_locations IS
  'Physical zone role only. No extra stock balance; unmapped historical zones remain unassigned.';
COMMENT ON VIEW public.v_stock_lane_positions_1028 IS
  'Existing physical positions and reservation purposes. Lot-status availability is not a substitute for the operational quality gate.';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT,UPDATE ON public.stock_lane_locations TO cerp_app;
    GRANT SELECT,INSERT ON public.stock_lane_configuration_events TO cerp_app;
    GRANT SELECT ON public.v_stock_lane_positions_1028 TO cerp_app;
  END IF;
END $$;
COMMIT;
