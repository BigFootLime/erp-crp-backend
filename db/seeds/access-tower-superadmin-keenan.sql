-- Accorde le statut superadmin au seul compte pilote nommé KEENAN.
-- Ce statut n'est accordé par AUCUNE API : ce fichier est le seul chemin d'octroi.
-- Le seed est idempotent et ne modifie aucune autre colonne du compte.
--
-- cerp_test :
--   psql -d cerp_test -f db/seeds/access-tower-superadmin-keenan.sql
--
-- cerp_prod (uniquement après validation sur cerp_test et sauvegarde, en une session) :
--   SET cerp.access_tower_superadmin_approved = 'KEENAN';
--   \i db/seeds/access-tower-superadmin-keenan.sql

DO $$
DECLARE
  v_user_id integer;
  v_user_count integer;
BEGIN
  IF current_database() = 'cerp_prod'
     AND current_setting('cerp.access_tower_superadmin_approved', true) IS DISTINCT FROM 'KEENAN' THEN
    RAISE EXCEPTION 'INTERDIT : validation explicite KEENAN requise avant octroi superadmin sur cerp_prod';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'is_superadmin'
  ) THEN
    RAISE EXCEPTION 'Colonne users.is_superadmin absente — appliquer d''abord db/patches/20260727_admin_access_tower_326.sql';
  END IF;

  -- Un homonyme rendrait l'octroi ambigu : on refuse plutôt que de choisir.
  SELECT count(*), min(id)
    INTO v_user_count, v_user_id
    FROM public.users
   WHERE upper(btrim(username)) = 'KEENAN';

  IF v_user_count <> 1 THEN
    RAISE EXCEPTION 'Compte superadmin KEENAN introuvable ou ambigu (% correspondances)', v_user_count;
  END IF;

  UPDATE public.users
     SET is_superadmin = true
   WHERE id = v_user_id
     AND is_superadmin IS DISTINCT FROM true;
END $$;

SELECT id, username, is_superadmin
FROM public.users
WHERE is_superadmin
ORDER BY id;
