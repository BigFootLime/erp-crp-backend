BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.quality_control
  ADD COLUMN operator_receipt_control boolean NOT NULL DEFAULT false;

ALTER TABLE public.quality_control
  ADD CONSTRAINT quality_control_context_v3_chk CHECK (
    CASE WHEN operator_receipt_control THEN coalesce(
      control_type = 'RECEPTION' AND trigger_type = 'RECEPTION'
      AND source_type = 'LOT' AND source_id = lot_id::text
      AND reception_ligne_id IS NOT NULL AND lot_id IS NOT NULL AND article_id IS NOT NULL
      AND affaire_id IS NULL AND of_id IS NULL AND operation_id IS NULL AND piece_technique_id IS NULL
      AND plan_id IS NULL AND plan_version IS NULL AND plan_snapshot IS NULL AND plan_snapshot_sha256 IS NULL
      AND qty_population > 0 AND validation_date IS NOT NULL AND validated_by IS NOT NULL
      AND status IN ('VALIDATED', 'REJECTED'), false)
    ELSE affaire_id IS NOT NULL OR of_id IS NOT NULL OR piece_technique_id IS NOT NULL OR coalesce(
      source_type = 'LOT' AND source_id = lot_id::text AND lot_id IS NOT NULL AND article_id IS NOT NULL
      AND plan_id IS NOT NULL AND plan_snapshot_sha256 IS NOT NULL AND qty_population > 0, false)
    END
  ) NOT VALID;

ALTER TABLE public.quality_control VALIDATE CONSTRAINT quality_control_context_v3_chk;
ALTER TABLE public.quality_control DROP CONSTRAINT quality_control_context_v2_chk;

CREATE FUNCTION public.guard_quality_operator_receipt_control() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.operator_receipt_control IS DISTINCT FROM OLD.operator_receipt_control THEN
    RAISE EXCEPTION 'The origin of a quality control is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.operator_receipt_control AND NOT EXISTS (
    SELECT 1 FROM public.reception_fournisseur_lignes l
    JOIN public.receptions_fournisseurs r ON r.id = l.reception_id
    JOIN public.articles a ON a.id = l.article_id
    JOIN public.lots lot ON lot.id = l.lot_id AND lot.article_id = a.id
    CROSS JOIN LATERAL (
      SELECT l.qty_received::double precision * coalesce(l.stock_conversion_coef, 1)::double precision AS raw
    ) converted
    WHERE l.id = NEW.reception_ligne_id AND l.lot_id = NEW.lot_id AND l.article_id = NEW.article_id
      AND r.fournisseur_id = NEW.fournisseur_id AND r.origin_type = 'SUPPLIER'
      AND (TG_OP <> 'INSERT' OR r.status = 'OPEN')
      AND a.article_category = 'matiere' AND l.stock_managed AND l.receipt_quality_required
      AND l.receipt_tool_id IS NULL AND l.stock_unit = NEW.unite
      -- Mirror convertedStockQuantity: round to 0.001 and allow only rounding noise.
      AND round(converted.raw * 1000) / 1000 = NEW.qty_population::double precision
      AND abs(converted.raw - NEW.qty_population::double precision) <= 1e-8
  ) THEN
    RAISE EXCEPTION 'The operator control must match its raw-material receipt line, lot, article and population'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_quality_operator_receipt_control() OWNER TO cerp_app;

CREATE TRIGGER guard_quality_operator_receipt_control
  BEFORE INSERT OR UPDATE OF operator_receipt_control, reception_ligne_id, lot_id, article_id,
    fournisseur_id, unite, qty_population ON public.quality_control
  FOR EACH ROW EXECUTE FUNCTION public.guard_quality_operator_receipt_control();

COMMIT;
