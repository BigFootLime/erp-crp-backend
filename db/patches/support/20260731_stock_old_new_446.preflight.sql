\set ON_ERROR_STOP on

-- #446 preflight. This file is deliberately read-only: it only inspects the
-- active database before the additive OLD/NEW stock-scope patch is applied.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

SELECT prerequisite, present
FROM (
  VALUES
    ('warehouses', to_regclass('public.warehouses') IS NOT NULL),
    ('magasins', to_regclass('public.magasins') IS NOT NULL),
    ('emplacements', to_regclass('public.emplacements') IS NOT NULL),
    ('lots', to_regclass('public.lots') IS NOT NULL),
    ('articles_achat', to_regclass('public.articles_achat') IS NOT NULL),
    ('article_category_ref', to_regclass('public.article_category_ref') IS NOT NULL),
    ('stock_movements', to_regclass('public.stock_movements') IS NOT NULL),
    ('stock_movement_lines', to_regclass('public.stock_movement_lines') IS NOT NULL)
) AS checks(prerequisite, present)
ORDER BY prerequisite;

DO $$
DECLARE
  v_magasin_id_type text;
  v_emplacement_magasin_id_type text;
  v_required_magasin_columns integer;
BEGIN
  IF to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.magasins') IS NULL
     OR to_regclass('public.emplacements') IS NULL
     OR to_regclass('public.lots') IS NULL
     OR to_regclass('public.articles_achat') IS NULL
     OR to_regclass('public.article_category_ref') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.stock_movement_lines') IS NULL THEN
    RAISE EXCEPTION '#446 preflight failed: required stock/article relations are missing';
  END IF;

  SELECT format_type(att.atttypid, att.atttypmod)
  INTO v_magasin_id_type
  FROM pg_attribute att
  WHERE att.attrelid = 'public.magasins'::regclass
    AND att.attname = 'id'
    AND NOT att.attisdropped;

  SELECT format_type(att.atttypid, att.atttypmod)
  INTO v_emplacement_magasin_id_type
  FROM pg_attribute att
  WHERE att.attrelid = 'public.emplacements'::regclass
    AND att.attname = 'magasin_id'
    AND NOT att.attisdropped;

  IF v_magasin_id_type <> 'uuid' OR v_emplacement_magasin_id_type <> 'uuid' THEN
    RAISE EXCEPTION
      '#446 preflight requires UUID magasins.id/emplacements.magasin_id (found % / %)',
      v_magasin_id_type,
      v_emplacement_magasin_id_type;
  END IF;

  SELECT count(*) INTO v_required_magasin_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'magasins'
    AND (
      (column_name IN ('code_magasin', 'libelle')
       AND data_type = 'character varying' AND is_nullable = 'NO')
      OR (column_name = 'actif' AND data_type = 'boolean')
    );
  IF v_required_magasin_columns <> 3 THEN
    RAISE EXCEPTION
      '#446 preflight requires NOT NULL magasins.code_magasin/libelle varchar and magasins.actif boolean';
  END IF;

  IF (SELECT count(*) FROM public.article_category_ref WHERE code = 'achat_transforme') <> 1 THEN
    RAISE EXCEPTION '#446 preflight requires exactly one achat_transforme category';
  END IF;
END $$;

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'magasins' AND column_name IN ('id', 'code', 'code_magasin', 'name', 'libelle', 'is_active', 'actif'))
    OR (table_name = 'emplacements' AND column_name = 'magasin_id')
    OR (table_name = 'lots' AND column_name = 'id')
    OR (table_name = 'article_category_ref' AND column_name IN ('code', 'label'))
  )
ORDER BY table_name, column_name;

SELECT
  code,
  label,
  count(*) OVER () AS matching_category_rows
FROM public.article_category_ref
WHERE code = 'achat_transforme';

SELECT
  code,
  name
FROM public.warehouses
WHERE code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP')
ORDER BY code;

SELECT
  code,
  code_magasin,
  name,
  libelle,
  is_active,
  actif
FROM public.magasins
WHERE code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP')
ORDER BY code;

COMMIT;
