import {createHash,randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {assertBlankTemplate} from '../managed-tests/template';
import {privateOwnerSeedSchema,directoryIdSchema,directoryDatabaseSchema} from './model';
const schema=`
CREATE TABLE public.cerp_shared_directory(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),directory_id uuid NOT NULL UNIQUE,schema_version integer NOT NULL CHECK(schema_version=1),import_mode text NOT NULL CHECK(import_mode='EMPTY_NO_LEGACY_IMPORT'),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cerp_directory_profiles(profile_id uuid PRIMARY KEY,user_id integer NOT NULL UNIQUE REFERENCES public.users(id),job_title text,employment_type text,weekly_hours_target numeric(6,2),work_profile_incomplete boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cerp_directory_memberships(profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id),database_id text NOT NULL CHECK(database_id IN ('cerp_prod','cerp_test') OR database_id~'^cerp_test_[a-f0-9]{32}$'),role_key text NOT NULL REFERENCES public.app_roles(role_key),roles text[] NOT NULL DEFAULT '{}'::text[],status text NOT NULL CHECK(status IN ('Active','Inactive','Blocked')),is_superadmin boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 0 CHECK(version>=0),PRIMARY KEY(profile_id,database_id));
CREATE TABLE public.cerp_directory_bootstrap_commands(command_id uuid PRIMARY KEY,request_hash text NOT NULL,profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cerp_directory_sessions(token_hash text PRIMARY KEY,profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id),database_id text NOT NULL,global_session_epoch bigint NOT NULL,membership_version integer NOT NULL,mfa_factor_id uuid NOT NULL REFERENCES public.user_mfa_factors(id),mfa_factor_version integer NOT NULL,mfa_verified_at timestamptz NOT NULL,mfa_method text NOT NULL CHECK(mfa_method IN ('totp','recovery_code')),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cerp_directory_challenges(token_hash text PRIMARY KEY,database_id text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE public.cerp_directory_call_nonces(nonce uuid PRIMARY KEY,expires_at timestamptz NOT NULL);
REVOKE ALL ON public.cerp_shared_directory,public.cerp_directory_bootstrap_commands FROM PUBLIC,cerp_app;
GRANT SELECT ON public.cerp_shared_directory TO cerp_directory_app;
GRANT SELECT,INSERT,UPDATE ON public.cerp_directory_profiles,public.cerp_directory_memberships TO cerp_directory_app;
GRANT SELECT,INSERT,DELETE ON public.cerp_directory_sessions,public.cerp_directory_challenges,public.cerp_directory_call_nonces TO cerp_directory_app;
`;
/** Installs a NEW isolated authority. Never runs against existing Prod/Test. */
export async function installEmptyDirectory(client:Client,expectedDirectoryId:string,rawSeed:unknown){
 const directoryId=directoryIdSchema.parse(expectedDirectoryId),seed=privateOwnerSeedSchema.parse(rawSeed);
 const expectedDatabase=`cerp_directory_${directoryId.replace(/-/g,'')}`;
 directoryDatabaseSchema.parse(expectedDatabase);
 const actual=(await client.query<{db:string}>('SELECT current_database() AS db')).rows[0];
 if(actual?.db!==expectedDatabase)throw new Error('DIRECTORY_INSTALL_TARGET_MISMATCH');
 const hash=createHash('sha256').update(JSON.stringify(seed)).digest('hex');
 await client.query('BEGIN');
 try{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cerp:shared-directory:install',0))");
  const exists=(await client.query("SELECT to_regclass('public.cerp_shared_directory') IS NOT NULL AS ok")).rows[0]?.ok;
  if(exists){
   const marker=(await client.query('SELECT directory_id FROM public.cerp_shared_directory WHERE singleton=true')).rows[0];
   const replay=(await client.query('SELECT request_hash,profile_id FROM public.cerp_directory_bootstrap_commands WHERE command_id=$1::uuid',[seed.command_id])).rows[0];
   if(marker?.directory_id!==directoryId || replay?.request_hash!==hash)throw new Error('DIRECTORY_INSTALL_ALREADY_INITIALIZED');
   await client.query('COMMIT');return {directory_id:directoryId,profile_id:replay.profile_id,replayed:true};
  }
  await assertBlankTemplate(client);
  const role=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='cerp_directory_app'")).rows[0];
  if(!role||role.rolsuper||role.rolcreatedb||role.rolcreaterole)throw new Error('DIRECTORY_PRIVATE_DATABASE_ROLE_REQUIRED');
  if(!(await client.query("SELECT 1 FROM public.app_roles WHERE role_key='Administrateur Systeme et Reseau'")).rows.length)throw new Error('DIRECTORY_OWNER_ROLE_MISSING');
  await client.query(schema);
  // Business APIs use cerp_app; they must never connect to the credential DB.
  await client.query(`REVOKE ALL ON DATABASE "${expectedDatabase}" FROM PUBLIC,cerp_app; GRANT CONNECT ON DATABASE "${expectedDatabase}" TO cerp_directory_app`);
  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cerp_app; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM cerp_app');
  const privateTables=(await client.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND
   (tablename IN ('users','app_roles','app_modules','cerp_schema_migrations','user_role_assignments','user_role_assignment_events','auth_login_logs','auth_mfa_challenges','erp_audit_logs','erp_outbox_events','password_resets','password_reset_tokens','factureur','finance_legal_mentions','erp_settings','erp_setup_company_commands','test_account_registrations','user_avatar_commands','cerp_terminal_pins','operator_badge_credentials','operator_device_sessions','cerp_terminal_audit')
    OR tablename LIKE 'user_mfa_%' OR tablename LIKE 'auth_rate_limit_%' OR tablename LIKE 'admin_%' OR tablename LIKE 'hr_%' OR tablename LIKE 'realtime_%' OR tablename LIKE 'operational_media_%')`)).rows;
  for(const {tablename} of privateTables)await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."${tablename.replace(/"/g,'""')}" TO cerp_directory_app`);
  await client.query('GRANT USAGE ON SCHEMA public TO cerp_directory_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cerp_directory_app');
  const functions=(await client.query<{signature:string}>("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'cerp_realtime_%'")).rows;
  for(const fn of functions)await client.query(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO cerp_directory_app`);
  await client.query('REVOKE INSERT,UPDATE,DELETE ON public.app_roles,public.app_modules,public.cerp_schema_migrations FROM cerp_directory_app');
  await client.query('GRANT SELECT,UPDATE ON public.planning_central_settings TO cerp_directory_app');
  await client.query('GRANT SELECT,INSERT,UPDATE ON public.planning_recalculation_jobs TO cerp_directory_app');
  await client.query("INSERT INTO public.erp_settings(key,value_text) VALUES('security.mfa_policy','required_for_all') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await client.query("INSERT INTO public.cerp_shared_directory(directory_id,schema_version,import_mode) VALUES($1::uuid,1,'EMPTY_NO_LEGACY_IMPORT')",[directoryId]);
  const {profile,authentication}=seed;
  const user=(await client.query<{id:number}>(`INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin,mfa_reenrollment_required,avatar_key,country)
   VALUES($1,$2,$3,$4,$5,'Administrateur Systeme et Reseau','Active',true,true,NULL,'France') RETURNING id`,[profile.username,authentication.password_hash,profile.name,profile.surname,profile.email])).rows[0];
  await client.query("INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,'Administrateur Systeme et Reseau')",[user.id]);
  const profileId=randomUUID();
  await client.query('INSERT INTO public.cerp_directory_profiles(profile_id,user_id,job_title,employment_type,weekly_hours_target) VALUES($1::uuid,$2,$3,$4,$5)',[profileId,user.id,profile.job_title,profile.employment_type,profile.weekly_hours]);
  // Only the human-requested owner receives Production rights. Later public
  // Test registrations must never inherit this bootstrap membership.
  await client.query("INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,status,is_superadmin) VALUES($1,'cerp_prod','Administrateur Systeme et Reseau','Active',true),($1,'cerp_test','Administrateur Systeme et Reseau','Active',true)",[profileId]);
  await client.query('INSERT INTO public.cerp_directory_bootstrap_commands(command_id,request_hash,profile_id) VALUES($1::uuid,$2,$3::uuid)',[seed.command_id,hash,profileId]);
  await client.query('COMMIT');return {directory_id:directoryId,profile_id:profileId,replayed:false};
 }catch(error){await client.query('ROLLBACK');throw error;}
}
