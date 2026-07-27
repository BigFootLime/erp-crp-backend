SELECT
  column_name,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
  AND column_name IN (
    'tel_no',
    'gender',
    'address',
    'lane',
    'house_no',
    'postcode',
    'date_of_birth',
    'social_security_number'
  )
ORDER BY column_name;
