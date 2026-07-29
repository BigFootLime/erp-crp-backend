-- 20260729_finance_legal_mentions_hardening_221.sql
--
-- Follow-up to 20260729_finance_legal_mentions.sql for issue #221.
--
-- The initial patch was already applied to cerp_test before review, so it remains immutable.
-- This additive patch closes two integrity gaps without rewriting the seeded legal version:
--   1. two closed legal versions could overlap and make date resolution ambiguous;
--   2. the snapshot function did not explicitly choose the latest matching version.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.finance_legal_mentions') IS NULL THEN
    RAISE EXCEPTION '#221: public.finance_legal_mentions is missing — apply 20260729_finance_legal_mentions.sql first';
  END IF;
END $$;

-- Refuse to harden an already ambiguous history. No automatic correction is safe for fiscal
-- reference data: an operator must decide which effective period is authoritative.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.finance_legal_mentions left_version
    JOIN public.finance_legal_mentions right_version
      ON right_version.biller_id = left_version.biller_id
     AND right_version.mention_set_id > left_version.mention_set_id
     AND daterange(
           left_version.effective_from,
           left_version.effective_to,
           '[)'
         ) && daterange(
           right_version.effective_from,
           right_version.effective_to,
           '[)'
         )
  ) THEN
    RAISE EXCEPTION '#221: overlapping finance_legal_mentions periods exist — manual Finance arbitration required';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS finance_legal_mentions_effective_from_uidx
  ON public.finance_legal_mentions (biller_id, effective_from);

CREATE OR REPLACE FUNCTION public.tg_finance_legal_mentions_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize period changes for one issuer. Without this transaction-level lock, two
  -- concurrent inserts could both pass the overlap test before either becomes visible.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('finance_legal_mentions:' || NEW.biller_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.finance_legal_mentions existing
    WHERE existing.biller_id = NEW.biller_id
      AND existing.mention_set_id <> NEW.mention_set_id
      AND daterange(
            existing.effective_from,
            existing.effective_to,
            '[)'
          ) && daterange(
            NEW.effective_from,
            NEW.effective_to,
            '[)'
          )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'finance_legal_mentions periods must not overlap for one issuer';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_legal_mentions_no_overlap_trg
  ON public.finance_legal_mentions;
CREATE TRIGGER finance_legal_mentions_no_overlap_trg
BEFORE INSERT OR UPDATE OF biller_id, effective_from, effective_to
ON public.finance_legal_mentions
FOR EACH ROW
EXECUTE FUNCTION public.tg_finance_legal_mentions_no_overlap();

-- Deterministic resolution remains explicit even with the trigger. It protects reads if the
-- table is restored from an old backup or temporarily loaded before constraints are checked.
CREATE OR REPLACE FUNCTION public.fn_finance_issuer_snapshot(p_biller_id uuid, p_at date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'biller_id',                 f.biller_id,
    'company_name',              f.biller_name,
    'address_line_1',            NULLIF(btrim(concat_ws(' ', f.house_number, f.street)), ''),
    'postal_code',               f.postal_code,
    'city',                      f.city,
    'country',                   f.country,
    'phone',                     f.phone,
    'email',                     f.email,
    'bank_name',                 f.default_bank_name,
    'iban',                      f.default_iban,
    'bic',                       f.default_bic,
    'text_on_invoice',           f.text_on_invoice,

    'legal_form',                m.legal_form,
    'share_capital',             m.share_capital::text,
    'share_capital_currency',    CASE WHEN m.share_capital IS NULL THEN NULL ELSE m.share_capital_currency END,
    'rcs_city',                  m.rcs_city,
    'rcs_number',                m.rcs_number,
    'siren',                     m.siren,
    'siret',                     m.siret,
    'vat_number',                m.vat_number,
    'ape_code',                  m.ape_code,

    'late_penalty_rate',         m.late_penalty_rate::text,
    'late_penalty_basis',        m.late_penalty_basis,
    'recovery_indemnity',        CASE WHEN m.mention_set_id IS NULL THEN NULL ELSE m.recovery_indemnity::text END,
    'early_discount_rate',       m.early_discount_rate::text,
    'early_discount_basis',      m.early_discount_basis,
    'vat_on_receipts',           CASE WHEN m.vat_on_receipts THEN true ELSE NULL END,
    'vat_exempt_293b',           CASE WHEN m.vat_exempt_293b THEN true ELSE NULL END,
    'retention_of_title',        m.retention_of_title,
    'extra_mentions',            CASE WHEN m.extra_mentions IS NULL OR cardinality(m.extra_mentions) = 0
                                      THEN NULL ELSE to_jsonb(m.extra_mentions) END,
    'legal_mentions_version',        m.version,
    'legal_mentions_effective_from', m.effective_from::text
  ))
  FROM public.factureur f
  LEFT JOIN LATERAL (
    SELECT resolved.*
    FROM public.finance_legal_mentions resolved
    WHERE resolved.biller_id = f.biller_id
      AND resolved.effective_from <= p_at
      AND (resolved.effective_to IS NULL OR resolved.effective_to > p_at)
    ORDER BY resolved.effective_from DESC, resolved.version DESC
    LIMIT 1
  ) m ON TRUE
  WHERE f.biller_id = p_biller_id;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    EXECUTE 'ALTER FUNCTION public.tg_finance_legal_mentions_no_overlap() OWNER TO cerp_app';
    EXECUTE 'ALTER FUNCTION public.fn_finance_issuer_snapshot(uuid, date) OWNER TO cerp_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tg_finance_legal_mentions_no_overlap() TO cerp_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_finance_issuer_snapshot(uuid, date) TO cerp_app';
  END IF;
END $$;

COMMIT;
