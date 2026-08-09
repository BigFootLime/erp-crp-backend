-- Read-only preflight for GPT56-CERP-0001-A. Expected: preflight_ok = true.

SELECT
  to_regclass('public.users') IS NOT NULL
  AND to_regclass('public.erp_audit_logs') IS NOT NULL
  AND NOT EXISTS (
    SELECT required.column_name
    FROM unnest(ARRAY[
      'id', 'username', 'password', 'name', 'surname', 'email', 'role',
      'tel_no', 'gender', 'address', 'lane', 'house_no', 'postcode',
      'salary', 'date_of_birth', 'employment_date', 'employment_end_date',
      'national_id', 'status', 'social_security_number'
    ]) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'users'
        AND c.column_name = required.column_name
    )
  ) AS preflight_ok;
