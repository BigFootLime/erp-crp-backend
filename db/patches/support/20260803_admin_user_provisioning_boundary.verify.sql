-- Read-only verification for GPT56-CERP-0001-A. Every boolean must be true.

SELECT
  to_regclass('public.admin_user_provisioning_requests') IS NOT NULL AS has_idempotency_table,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.admin_user_provisioning_requests'::regclass
      AND contype = 'p'
  ) AS has_idempotency_primary_key,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = ANY (ARRAY[
        'tel_no', 'gender', 'address', 'lane', 'house_no', 'postcode',
        'salary', 'date_of_birth', 'employment_date', 'employment_end_date',
        'national_id', 'social_security_number'
      ])
      AND is_nullable <> 'YES'
  ) AS hr_profile_is_optional,
  NOT EXISTS (
    SELECT 1
    FROM public.admin_user_provisioning_requests
    WHERE request_hash !~ '^[0-9a-f]{64}$'
       OR expires_at <= created_at
  ) AS idempotency_rows_are_valid;
