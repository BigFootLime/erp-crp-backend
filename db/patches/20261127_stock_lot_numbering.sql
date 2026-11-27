BEGIN;
SET LOCAL lock_timeout = '5s';

-- Independent series share one row so a mixed receipt has one counter lock.
CREATE TABLE public.stock_lot_code_counters (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_material_number bigint NOT NULL CHECK (last_material_number >= 7999),
  last_treatment_number bigint NOT NULL CHECK (last_treatment_number >= 0)
);

LOCK TABLE public.lots IN SHARE ROW EXCLUSIVE MODE;

WITH current_codes AS (SELECT upper(btrim(lot_code)) AS code FROM public.lots)
INSERT INTO public.stock_lot_code_counters (last_material_number, last_treatment_number)
SELECT
  GREATEST(7999, max(substring(code FROM 4)::numeric) FILTER (WHERE code LIKE 'MP-%')),
  GREATEST(0, max(substring(code FROM 4)::numeric) FILTER (WHERE code LIKE 'TR-%'))
FROM current_codes
WHERE code ~ '^(MP|TR)-[0-9]{4,}$';

CREATE FUNCTION public.protect_numbered_stock_lot_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lot_code IS DISTINCT FROM OLD.lot_code AND (
    btrim(OLD.lot_code) ~* '^(MP|TR)-[0-9]{4,}$' OR btrim(NEW.lot_code) ~* '^(MP|TR)-[0-9]{4,}$'
  ) THEN
    RAISE EXCEPTION 'Numbered stock lot code is reserved and immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'stock_lot_numbered_code_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_lot_numbered_code_immutable
  BEFORE UPDATE OF lot_code ON public.lots
  FOR EACH ROW EXECUTE FUNCTION public.protect_numbered_stock_lot_code();

CREATE TABLE public.stock_received_bar_counters (
  lot_id uuid PRIMARY KEY REFERENCES public.lots (id),
  last_number bigint NOT NULL CHECK (last_number > 0)
);

ALTER TABLE public.stock_material_bars
  ADD COLUMN receipt_bar_code text,
  ADD CONSTRAINT stock_material_bars_receipt_code_ck
    CHECK (receipt_bar_code IS NULL OR receipt_bar_code ~ '^MP-[0-9]{4,}-[1-9][0-9]*$');

CREATE UNIQUE INDEX stock_material_bars_receipt_code_uq
  ON public.stock_material_bars (receipt_bar_code)
  WHERE receipt_bar_code IS NOT NULL;

CREATE FUNCTION public.protect_received_bar_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receipt_bar_code IS DISTINCT FROM OLD.receipt_bar_code THEN
    RAISE EXCEPTION 'Physical bar receipt code is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_material_bar_receipt_code_immutable
  BEFORE UPDATE OF receipt_bar_code ON public.stock_material_bars
  FOR EACH ROW EXECUTE FUNCTION public.protect_received_bar_code();

GRANT SELECT, UPDATE ON public.stock_lot_code_counters TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON public.stock_received_bar_counters TO cerp_app;
COMMIT;
