BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- #611 conditionally attached producers that existed at its installation time.
-- The new user-avatar producer must also cover schemas whose users photo column
-- was introduced after that historical patch.
INSERT INTO public.operational_media_assets(storage_key)
 SELECT public.fn_operational_media_normalize_key(profile_picture) FROM public.users
 WHERE public.fn_operational_media_normalize_key(profile_picture) IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO public.operational_media_bindings(asset_id,owner_type,owner_id,field_key,module_key)
 SELECT a.id,'user',u.id::text,'profile_picture','chat' FROM public.users u
 JOIN public.operational_media_assets a ON a.storage_key=public.fn_operational_media_normalize_key(u.profile_picture)
 ON CONFLICT (owner_type,owner_id,field_key) DO UPDATE SET asset_id=EXCLUDED.asset_id,module_key=EXCLUDED.module_key;
DROP TRIGGER IF EXISTS trg_operational_media_users_profile_picture ON public.users;
CREATE TRIGGER trg_operational_media_users_profile_picture AFTER INSERT OR UPDATE OR DELETE ON public.users
 FOR EACH ROW EXECUTE FUNCTION public.fn_operational_media_sync_binding('user','id','profile_picture','chat');
CREATE TABLE IF NOT EXISTS public.user_avatar_commands (
  idempotency_key uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES public.users(id),
  user_id integer NOT NULL REFERENCES public.users(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  asset_id uuid NOT NULL REFERENCES public.operational_media_assets(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_avatar_commands_user_idx ON public.user_avatar_commands(user_id,created_at);
GRANT SELECT,INSERT ON public.user_avatar_commands TO cerp_app;
COMMIT;
