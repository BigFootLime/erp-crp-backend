/** Match the deployed canonical biller schema, including its legacy audit names/types. */
exports.prepareCanonicalCompanyFixture=async function(db){
 const actual=(await db.query('SELECT current_user actor,current_database() name,inet_server_port() port')).rows[0];
 if(actual.actor!=='cerp_fixture'||actual.port!==15463||!/^cerp_(directory|test)_[a-f0-9]{32}$/.test(actual.name))throw Error('OWNED_COMPANY_FIXTURE_REQUIRED');
 if((await db.query('SELECT count(*)::int n FROM public.factureur')).rows[0].n!==0)throw Error('EMPTY_COMPANY_FIXTURE_REQUIRED');
 const names=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='factureur'")).rows.map(r=>r.column_name);
 // Older local templates were built from a synthetic bootstrap with wrong names.
 if(names.includes('created_at'))await db.query('ALTER TABLE public.factureur RENAME COLUMN created_at TO creation_date');
 if(names.includes('updated_at'))await db.query('ALTER TABLE public.factureur RENAME COLUMN updated_at TO modification_date');
 await db.query(`ALTER TABLE public.factureur
  ALTER COLUMN creation_date TYPE timestamp without time zone,
  ALTER COLUMN creation_date DROP NOT NULL,
  ALTER COLUMN creation_date SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN modification_date TYPE timestamp without time zone,
  ALTER COLUMN modification_date DROP NOT NULL,
  ALTER COLUMN modification_date SET DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS created_by character varying,
  ADD COLUMN IF NOT EXISTS modified_by character varying`);
 const cols=(await db.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='factureur' AND column_name IN ('creation_date','modification_date','created_by','modified_by','created_at','updated_at')")).rows;
 if(cols.length!==4||cols.some(c=>c.is_nullable!=='YES'||c.data_type!==(c.column_name.endsWith('_by')?'character varying':'timestamp without time zone')))throw Error('CANONICAL_COMPANY_SCHEMA_REQUIRED');
 if(actual.name.startsWith('cerp_test_')){
  // The synthetic template lacks historical business ACLs; grant only those
  // needed by this update of an already-projected profile and its company.
  await db.query(`GRANT SELECT,UPDATE ON public.users TO cerp_app;
   GRANT SELECT ON public.user_role_assignments,public.realtime_session_epochs TO cerp_app;
   GRANT SELECT,INSERT,UPDATE ON public.factureur,public.finance_legal_mentions TO cerp_app;
   GRANT SELECT,INSERT,UPDATE,DELETE ON public.erp_settings TO cerp_app`);
 }
};
