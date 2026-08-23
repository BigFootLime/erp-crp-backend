-- #611 Authenticated operational image delivery. Additive: legacy image path
-- columns remain the write compatibility layer; this registry is the only
-- read authority for private bytes.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'digest') THEN
    RAISE EXCEPTION 'OPERATIONAL_MEDIA_CRYPTO_DEPENDENCY_MISSING: pgcrypto/gen_random_uuid is required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.operational_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE CHECK (storage_key !~ '(^|/)[.][.](/|$)' AND storage_key !~ '^/'),
  mime_type text NULL,
  size_bytes bigint NULL CHECK (size_bytes IS NULL OR size_bytes > 0),
  sha256 text NULL CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  scan_status text NOT NULL DEFAULT 'LEGACY_UNVERIFIED' CHECK (scan_status IN ('CLEAN','PENDING','LEGACY_UNVERIFIED','QUARANTINED')),
  status text NOT NULL DEFAULT 'LEGACY_UNVERIFIED' CHECK (status IN ('ACTIVE','REVOKED','QUARANTINED','LEGACY_UNVERIFIED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mirrors normalizeStoredImagePath for local storage keys. Remote/blank and
-- platform absolute paths are not operational-media keys; traversal is never
-- normalized into validity.
CREATE OR REPLACE FUNCTION public.fn_operational_media_normalize_key(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v text;
  v_had_legacy_marker boolean := false;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
  -- Reject remote values before extracting a legacy marker: an attacker must
  -- not turn https://host/uploads/images/a.png into a local storage key.
  IF btrim(p_value) ~* '^https?://' THEN RETURN NULL; END IF;
  v := replace(btrim(p_value), E'\\', '/');
  -- Reject URI schemes before marker extraction. A Windows drive is the only
  -- tolerated colon form, and must still contain the established marker.
  IF v ~* '^[A-Za-z][A-Za-z0-9+.-]*:' AND v !~* '^[A-Za-z]:/' THEN RETURN NULL; END IF;
  -- Reject unsafe components in the complete legacy source before extracting
  -- a marker. Otherwise `../uploads/images/a.png` could shed its traversal.
  IF v ~ '[[:cntrl:]]' OR EXISTS (
    SELECT 1 FROM unnest(string_to_array(v, '/')) AS segment(value)
     WHERE value IN ('.', '..')
  ) THEN RETURN NULL; END IF;
  -- The legacy marker is a complete path segment, either at the beginning of
  -- a relative value or preceded by a slash in an absolute value.  Do not
  -- treat marker-like text (for example `notuploads/images/`) as authority.
  IF lower(v) LIKE 'uploads/images/%' THEN
    v := substr(v, length('uploads/images/') + 1);
    v_had_legacy_marker := true;
  ELSIF (v ~ '^[A-Za-z]:/' OR v ~ '^/') AND position('/uploads/images/' in lower(v)) > 0 THEN
    v := substr(v, position('/uploads/images/' in lower(v)) + length('/uploads/images/'));
    v_had_legacy_marker := true;
  END IF;
  -- Windows/UNC absolute input is tolerated only when it contains the known
  -- legacy images marker above; any other host/drive path is unsafe.
  IF v ~ '^[A-Za-z]:' OR v ~ '^//' OR v ~ ':' OR (NOT v_had_legacy_marker AND v ~ '^/') THEN RETURN NULL; END IF;
  v := trim(both '/' from v);
  -- Use segment comparison instead of a regex escape contract: PostgreSQL
  -- regular-expression escaping is easy to get wrong and must never admit a
  -- traversal component into a private storage key.
  IF v = '' OR EXISTS (
    SELECT 1
      FROM unnest(string_to_array(v, '/')) AS segment(value)
     WHERE value IN ('.', '..') OR value = ''
  ) THEN RETURN NULL; END IF;
  RETURN v;
END $$;

ALTER TABLE public.operational_media_assets
  DROP CONSTRAINT IF EXISTS chk_operational_media_canonical_key;
ALTER TABLE public.operational_media_assets
  ADD CONSTRAINT chk_operational_media_canonical_key
  CHECK (storage_key = public.fn_operational_media_normalize_key(storage_key));

-- Early #611 revisions used an anonymous inline ACTIVE MIME check. Replace
-- any such legacy check by definition so replay upgrades it to the explicit
-- PDF-aware contract rather than retaining a raster-only constraint forever.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.operational_media_assets'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status <> ''ACTIVE''%'
  LOOP
    EXECUTE format('ALTER TABLE public.operational_media_assets DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.operational_media_assets'::regclass
       AND conname = 'chk_operational_media_active_integrity'
  ) THEN
    ALTER TABLE public.operational_media_assets
      ADD CONSTRAINT chk_operational_media_active_integrity
      CHECK (status <> 'ACTIVE' OR (mime_type IN ('image/png','image/jpeg','image/webp','image/gif','application/pdf') AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND scan_status = 'CLEAN'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.operational_media_bindings (
  asset_id uuid NOT NULL REFERENCES public.operational_media_assets(id) ON DELETE CASCADE,
  owner_type text NOT NULL,
  owner_id text NOT NULL,
  field_key text NOT NULL,
  module_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_type, owner_id, field_key),
  UNIQUE (asset_id, owner_type, owner_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_operational_media_bindings_asset ON public.operational_media_bindings(asset_id);

-- PDF is deliberately a document-only format.  The registry is closed: a
-- clean ACTIVE PDF may be bound only to a tool plan or sketch, never to a
-- raster surface (including future, unrecognised bindings).  Both directions
-- are protected so activation-before-binding and binding-before-activation
-- cannot bypass the invariant.
CREATE OR REPLACE FUNCTION public.fn_operational_media_enforce_binding_mime()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'operational_media_assets' THEN
    IF NEW.status = 'ACTIVE' AND NEW.mime_type = 'application/pdf' AND EXISTS (
      SELECT 1
        FROM public.operational_media_bindings b
       WHERE b.asset_id = NEW.id
         AND NOT (b.owner_type = 'outil' AND b.field_key IN ('plan', 'esquisse'))
    ) THEN
      RAISE EXCEPTION 'OPERATIONAL_MEDIA_PDF_RASTER_BINDING_FORBIDDEN';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.operational_media_assets a
     WHERE a.id = NEW.asset_id
       AND a.status = 'ACTIVE'
       AND a.mime_type = 'application/pdf'
  ) AND NOT (NEW.owner_type = 'outil' AND NEW.field_key IN ('plan', 'esquisse')) THEN
    RAISE EXCEPTION 'OPERATIONAL_MEDIA_PDF_RASTER_BINDING_FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_operational_media_asset_mime_binding_policy ON public.operational_media_assets;
CREATE TRIGGER trg_operational_media_asset_mime_binding_policy
BEFORE INSERT OR UPDATE OF status, mime_type ON public.operational_media_assets
FOR EACH ROW EXECUTE FUNCTION public.fn_operational_media_enforce_binding_mime();

DROP TRIGGER IF EXISTS trg_operational_media_binding_mime_policy ON public.operational_media_bindings;
CREATE TRIGGER trg_operational_media_binding_mime_policy
BEFORE INSERT OR UPDATE OF asset_id, owner_type, field_key ON public.operational_media_bindings
FOR EACH ROW EXECUTE FUNCTION public.fn_operational_media_enforce_binding_mime();

-- Upgrade safety for an early #611 rollout that may already have activated a
-- PDF through a raster-only binding before this invariant existed.
UPDATE public.operational_media_assets a
   SET status = 'QUARANTINED', scan_status = 'QUARANTINED'
 WHERE a.status = 'ACTIVE' AND a.mime_type = 'application/pdf'
   AND EXISTS (
     SELECT 1 FROM public.operational_media_bindings b
      WHERE b.asset_id = a.id
        AND NOT (b.owner_type = 'outil' AND b.field_key IN ('plan', 'esquisse'))
   );

CREATE OR REPLACE FUNCTION public.fn_operational_media_sync_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_old_owner_id text;
  v_new_owner_id text;
  v_asset_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_owner_id := to_jsonb(OLD)->>TG_ARGV[1];
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_owner_id := to_jsonb(NEW)->>TG_ARGV[1];
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    DELETE FROM public.operational_media_bindings
      WHERE owner_type = TG_ARGV[0] AND owner_id = v_old_owner_id AND field_key = TG_ARGV[2];
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  v_value := public.fn_operational_media_normalize_key(to_jsonb(NEW)->>TG_ARGV[2]);
  IF v_value IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.operational_media_assets(storage_key) VALUES (v_value)
  ON CONFLICT (storage_key) DO UPDATE SET storage_key = EXCLUDED.storage_key
  RETURNING id INTO v_asset_id;
  INSERT INTO public.operational_media_bindings(asset_id, owner_type, owner_id, field_key, module_key)
  VALUES (v_asset_id, TG_ARGV[0], v_new_owner_id, TG_ARGV[2], TG_ARGV[3])
  ON CONFLICT (owner_type, owner_id, field_key) DO UPDATE
    SET asset_id = EXCLUDED.asset_id, module_key = EXCLUDED.module_key;
  RETURN NEW;
END $$;

-- Every historical producer is backfilled and receives a trigger so future
-- writes cannot bypass the registry. Conditional creation keeps this additive
-- patch deployable on installations that have not enabled a legacy module.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('clients','client','client_id','logo_path','clients'),
    ('fournisseurs','fournisseur','id','logo','fournisseurs'),
    ('users','user','id','profile_picture','chat'),
    ('machines','machine','id','image_path','production'),
    ('gestion_outils_outil','outil','id_outil','image','outillage'),
    ('gestion_outils_outil','outil','id_outil','plan','outillage'),
    ('gestion_outils_outil','outil','id_outil','esquisse','outillage'),
    ('gestion_outils_famille','outil_famille','id_famille','image_path','outillage'),
    ('gestion_outils_geometrie','outil_geometrie','id_geometrie','image_path','outillage'),
    ('gestion_outils_fabricant','outil_fabricant','id_fabricant','logo','outillage')
  ) AS x(tbl, owner_type, id_col, field_col, module_key) LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.field_col)
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.id_col) THEN
      EXECUTE format('INSERT INTO public.operational_media_assets(storage_key) SELECT public.fn_operational_media_normalize_key(%1$I) FROM public.%2$I WHERE public.fn_operational_media_normalize_key(%1$I) IS NOT NULL ON CONFLICT DO NOTHING', r.field_col, r.tbl);
      EXECUTE format('INSERT INTO public.operational_media_bindings(asset_id, owner_type, owner_id, field_key, module_key) SELECT a.id, %2$L, s.%3$I::text, %1$L, %4$L FROM public.%5$I s JOIN public.operational_media_assets a ON a.storage_key = public.fn_operational_media_normalize_key(s.%1$I) WHERE public.fn_operational_media_normalize_key(s.%1$I) IS NOT NULL ON CONFLICT (owner_type, owner_id, field_key) DO UPDATE SET asset_id = EXCLUDED.asset_id, module_key = EXCLUDED.module_key', r.field_col, r.owner_type, r.id_col, r.module_key, r.tbl);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_operational_media_%1$s_%2$s ON public.%1$I', r.tbl, r.field_col);
      EXECUTE format('CREATE TRIGGER trg_operational_media_%1$s_%2$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.fn_operational_media_sync_binding(%3$L,%4$L,%2$L,%5$L)', r.tbl, r.field_col, r.owner_type, r.id_col, r.module_key);
    END IF;
  END LOOP;
END $$;

COMMIT;
