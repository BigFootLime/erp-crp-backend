-- #1831: ERP-issued family codes and a single family-owned abbreviation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.surface_finish_families, public.surface_finishes IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE IF NOT EXISTS public.surface_finish_family_code_seq AS bigint MINVALUE 1 MAXVALUE 999999 NO CYCLE;
ALTER TABLE public.surface_finish_families
  ADD COLUMN IF NOT EXISTS nom_diminutif text NULL,
  ADD COLUMN IF NOT EXISTS legacy_code text NULL;

-- Every finish still references exactly one family; recoding cascades that FK.
ALTER TABLE public.surface_finishes DROP CONSTRAINT surface_finishes_family_fk;
ALTER TABLE public.surface_finishes ADD CONSTRAINT surface_finishes_family_fk
  FOREIGN KEY (family_code) REFERENCES public.surface_finish_families(code) ON UPDATE CASCADE ON DELETE RESTRICT;

DO $$
DECLARE r record; used bigint; current_value bigint; called boolean;
BEGIN
  SELECT COALESCE(max(substring(code FROM '^FPS_([0-9]{6})$')::bigint),0) INTO used FROM public.surface_finish_families;
  SELECT last_value,is_called INTO current_value,called FROM public.surface_finish_family_code_seq;
  IF used > current_value OR (used=current_value AND used>0 AND NOT called) THEN
    PERFORM setval('public.surface_finish_family_code_seq',used,true);
  END IF;
  FOR r IN SELECT code FROM public.surface_finish_families WHERE code !~ '^FPS_[0-9]{6}$' ORDER BY sort_order,label,code LOOP
    UPDATE public.surface_finish_families SET legacy_code=COALESCE(legacy_code,code),
      code='FPS_' || lpad(nextval('public.surface_finish_family_code_seq')::text,6,'0') WHERE code=r.code;
  END LOOP;
END $$;

-- Preserve only unambiguous abbreviations already entered by the user.
WITH candidates AS (
  SELECT family_code,min(upper(btrim(procede))) AS abbreviation
  FROM public.surface_finishes GROUP BY family_code
  HAVING count(DISTINCT upper(btrim(procede)))=1 AND min(upper(btrim(procede))) ~ '^[A-Z][A-Z0-9]{0,19}$'
), unique_candidates AS (
  SELECT c.* FROM candidates c WHERE (SELECT count(*) FROM candidates c2 WHERE c2.abbreviation=c.abbreviation)=1
)
UPDATE public.surface_finish_families f SET nom_diminutif=c.abbreviation
FROM unique_candidates c WHERE c.family_code=f.code AND f.nom_diminutif IS NULL;

-- User-authorized initial configuration of the existing reference families.
UPDATE public.surface_finish_families f SET nom_diminutif=m.abbreviation
FROM (VALUES ('ANODISATION','OAS'),('ANODISATION_DURE','OAD'),('PASSIVATION','PASS'),
 ('ZINGAGE','ZN'),('NICKELAGE_CHIMIQUE','NICH'),('CHROMAGE','CHR'),('BRUNISSAGE','BRUN'),
 ('PHOSPHATATION','PHOS'),('PEINTURE','PEINT'),('THERMOLAQUAGE','THERMO'),
 ('CATAPHORESE','CATA'),('PREPARATION_SURFACE','PREP'),('AUTRE','AUTRE')) m(legacy_code,abbreviation)
WHERE f.legacy_code=m.legacy_code AND f.nom_diminutif IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.surface_finish_families other WHERE other.nom_diminutif=m.abbreviation AND other.code<>f.code);

ALTER TABLE public.surface_finish_families ALTER COLUMN code SET DEFAULT
  ('FPS_' || lpad(nextval('public.surface_finish_family_code_seq')::text,6,'0'));
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.surface_finish_families'::regclass AND conname='surface_finish_families_generated_code_check') THEN
    ALTER TABLE public.surface_finish_families ADD CONSTRAINT surface_finish_families_generated_code_check CHECK(code ~ '^FPS_[0-9]{6}$');
    ALTER TABLE public.surface_finish_families ADD CONSTRAINT surface_finish_families_abbreviation_check CHECK(nom_diminutif IS NULL OR nom_diminutif ~ '^[A-Z][A-Z0-9]{0,19}$');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS surface_finish_families_abbreviation_active_uq
  ON public.surface_finish_families(nom_diminutif) WHERE is_active AND nom_diminutif IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS surface_finish_families_legacy_code_uq
  ON public.surface_finish_families(legacy_code) WHERE legacy_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_surface_finish_family_code_1831() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN RAISE EXCEPTION 'The ERP-issued finish family code is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS surface_finish_family_code_immutable_1831 ON public.surface_finish_families;
CREATE TRIGGER surface_finish_family_code_immutable_1831 BEFORE UPDATE OF code ON public.surface_finish_families
  FOR EACH ROW EXECUTE FUNCTION public.protect_surface_finish_family_code_1831();

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT a.grantee FROM pg_class c,
    LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='public.surface_finish_families'::regclass AND a.privilege_type='INSERT'
  LOOP
    EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE public.surface_finish_family_code_seq TO %s',
      CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END);
  END LOOP;
END $$;
COMMIT;
