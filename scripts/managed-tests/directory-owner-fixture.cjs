/** Isolated qualification fixture: canonical owner ACLs matter to FK and definer execution. */
exports.prepareDirectoryOwnerFixture=async function(db){
 const source=(await db.query('SELECT current_user actor,current_database() name,inet_server_port() port')).rows[0];
 if(source.actor!=='cerp_fixture'||source.port!==15463||!/^cerp_directory_[a-f0-9]{32}$/.test(source.name))throw Error('OWNED_DIRECTORY_FIXTURE_REQUIRED');
 await db.query('ALTER TABLE public.app_roles OWNER TO cerp_app');
 await db.query(`CREATE FUNCTION public.cerp_directory_definer_fixture_1568() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF current_user<>'cerp_app' THEN RAISE EXCEPTION 'Unexpected fixture definer'; END IF;
  PERFORM 1 FROM public.app_roles WHERE role_key=NEW.role_key;
  RETURN NEW;
 END $$`);
 await db.query('ALTER FUNCTION public.cerp_directory_definer_fixture_1568() OWNER TO cerp_app');
 await db.query('CREATE TRIGGER directory_definer_fixture_1568 AFTER INSERT ON public.user_role_assignments FOR EACH ROW EXECUTE FUNCTION public.cerp_directory_definer_fixture_1568()');
};
