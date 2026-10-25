-- #1762 Private supplier catalogue provenance. This patch is additive and does
-- not reinterpret legacy zero stock as an uncounted catalogue quantity.

CREATE TABLE IF NOT EXISTS public.gestion_outils_catalogue_provenance (
  id_outil integer PRIMARY KEY REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  source_selection_id varchar(192) NOT NULL,
  source_document varchar(500) NOT NULL,
  source_sha256 char(64) NOT NULL,
  source_page integer NOT NULL CHECK (source_page > 0),
  source_rect jsonb NOT NULL,
  confirmed_by_user_id integer NOT NULL,
  confirmed_by_username varchar(255) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gestion_outils_catalogue_provenance_sha256_check CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT gestion_outils_catalogue_provenance_rect_check CHECK (jsonb_typeof(source_rect) = 'array' AND jsonb_array_length(source_rect) = 4)
);

ALTER TABLE public.gestion_outils_stock
  ADD COLUMN IF NOT EXISTS last_inventory_at timestamptz NULL;

-- The application check is friendlier, but only this index closes concurrent
-- create/update requests. Do not merge legacy duplicates automatically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.gestion_outils_outil
    WHERE id_fabricant IS NOT NULL AND reference_fabricant IS NOT NULL AND btrim(reference_fabricant) <> ''
    GROUP BY id_fabricant, lower(btrim(reference_fabricant))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add manufacturer/reference uniqueness: legacy duplicates require manual resolution';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS gestion_outils_outil_fabricant_reference_ci_unique
  ON public.gestion_outils_outil (id_fabricant, lower(btrim(reference_fabricant)))
  WHERE id_fabricant IS NOT NULL AND reference_fabricant IS NOT NULL AND btrim(reference_fabricant) <> '';
