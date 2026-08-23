-- Compatibility bridge for the two historical GED schema profiles.
--
-- cerp_test owns the closed entity registry from the known external 360 patch.
-- cerp_prod deliberately retained the legacy SOL-20 link guard.  The immutable
-- entity-contract patch that follows needs the registry while it runs, so this
-- patch creates a strictly temporary bridge only on the legacy, empty-link
-- profile.  The matching cleanup patch removes it in the same maintenance
-- window after the contract patch has been recorded.

BEGIN;

DO $bridge$
BEGIN
  IF to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_LINK_TABLE_MISSING';
  END IF;

  IF to_regclass('public.ged_entity_types') IS NOT NULL THEN
    IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL
       OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_ged_link_guard'
            AND tgrelid = 'public.ged_document_links'::regclass
            AND tgfoid = to_regprocedure('public.fn_ged_link_guard()')
            AND NOT tgisinternal
       ) THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_CLOSED_PROFILE_INVALID';
    END IF;
    RETURN;
  END IF;

  IF to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
          AND tgrelid = 'public.ged_document_links'::regclass
          AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_LEGACY_PROFILE_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ged_document_links) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_LEGACY_LINKS_NOT_EMPTY';
  END IF;
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_MARKER_ALREADY_EXISTS';
  END IF;

  EXECUTE $ddl$
    CREATE TABLE public.cerp_authoritative_pdf_ged_bridge_20260823 (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      source_profile text NOT NULL CHECK (source_profile = 'LEGACY_SOL20'),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  $ddl$;
  EXECUTE $ddl$
    INSERT INTO public.cerp_authoritative_pdf_ged_bridge_20260823(singleton, source_profile)
    VALUES (true, 'LEGACY_SOL20')
  $ddl$;
  EXECUTE $ddl$
    CREATE TABLE public.ged_entity_types (
      entity_type text PRIMARY KEY CHECK (entity_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      label text NOT NULL,
      module_key text NOT NULL,
      target_table text NOT NULL,
      target_pk_column text NOT NULL,
      sort_order integer NOT NULL DEFAULT 100,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  $ddl$;
  EXECUTE $seed$
    INSERT INTO public.ged_entity_types
      (entity_type, label, module_key, target_table, target_pk_column, sort_order, is_active)
    VALUES
      ('CLIENT',                  'Client',              'clients',           'clients',                  'client_id',  10, true),
      ('FOURNISSEUR',             'Fournisseur',         'fournisseurs',      'fournisseurs',             'id',         20, true),
      ('ARTICLE',                 'Article',             'stock',             'articles',                 'id',         30, true),
      ('PIECE_TECHNIQUE',         'Pièce technique',     'pieces-techniques', 'pieces_techniques',        'id',         40, true),
      ('PIECE_TECHNIQUE_VERSION', 'Indice de pièce',     'pieces-techniques', 'piece_technique_versions', 'id',         50, true),
      ('AFFAIRE',                 'Affaire',             'affaires',          'affaire',                  'id',         60, true),
      ('COMMANDE_CLIENT',         'Commande client',     'commande-client',   'commande_client',          'id',         70, true),
      ('OF',                      'Ordre de fabrication','production',        'ordres_fabrication',      'id',         80, true),
      ('RECEPTION',               'Réception',           'receptions',        'receptions_fournisseurs',  'id',         90, true),
      ('CONTROLE_QUALITE',        'Contrôle qualité',    'qualite',           'quality_control',          'id',        100, true),
      ('MACHINE',                 'Machine',             'production',        'machines',                 'id',        110, true),
      ('UTILISATEUR',             'Utilisateur',         'users',             'users',                    'id',        120, true)
  $seed$;
  EXECUTE $function$
    CREATE FUNCTION public.fn_ged_link_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM public.ged_entity_types t
         WHERE t.entity_type = NEW.entity_type AND t.is_active
      ) THEN
        RAISE EXCEPTION 'GED_ENTITY_TYPE_UNKNOWN: type d''entité inconnu ou inactif (%)', NEW.entity_type
          USING ERRCODE = 'check_violation';
      END IF;
      IF btrim(COALESCE(NEW.entity_id, '')) = '' THEN
        RAISE EXCEPTION 'GED_ENTITY_ID_REQUIRED: un lien exige l''identifiant de la fiche visée'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $body$
  $function$;
  EXECUTE $ddl$
    CREATE TRIGGER trg_ged_link_guard
      BEFORE INSERT OR UPDATE ON public.ged_document_links
      FOR EACH ROW EXECUTE FUNCTION public.fn_ged_link_guard()
  $ddl$;
END
$bridge$;

COMMIT;
