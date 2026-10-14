import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'dotenv';
import {createHash} from 'node:crypto';
import type {Client} from 'pg';
import {checkedChild,type ManagedHostConfig} from './host-config';
import {pgCommand,sqlIdentifier,withDatabase} from './postgres-host';

// These are code-owned technical catalogues, never company/account configuration.
const copiedCatalogues=['app_roles','app_modules','cerp_schema_migrations'];
const allowedNonempty=new Set([...copiedCatalogues,'currencies','units','production_machine_families','planning_central_settings','realtime_authorization_epoch','realtime_event_sequence_state','realtime_control_plane_v2_provenance','cerp_test_template_meta']);
export async function assertBlankTemplate(client:Client) {
  const tables=(await client.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {tablename} of tables) if(!allowedNonempty.has(tablename)) {
    const result=await client.query<{n:string}>(`SELECT count(*)::text AS n FROM public.${sqlIdentifier(tablename)}`);
    if(result.rows[0].n!=='0') throw new Error('MANAGED_TEMPLATE_HAS_BUSINESS_DATA');
  }
  const core=(await client.query<{ok:boolean}>("SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.user_avatar_commands') IS NOT NULL AND to_regclass('public.erp_setup_progress') IS NOT NULL AND to_regclass('public.of_workshop_print_jobs') IS NOT NULL AS ok")).rows[0];
  if(!core?.ok) throw new Error('MANAGED_TEMPLATE_SCHEMA_INCOMPLETE');
}
export async function verifyTemplate(config:ManagedHostConfig) {
  return withDatabase(config.admin_database_url,config.template_database,async client=>{
    await assertBlankTemplate(client);
    const meta=(await client.query<{version:string;release_path:string;index_sha256:string}>('SELECT version,release_path,index_sha256 FROM public.cerp_test_template_meta WHERE singleton=true')).rows[0];
    const index=path.join(config.api_release,'dist/index.js'),stat=await fs.lstat(index);
    if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_RELEASE_INVALID');
    const hash=createHash('sha256').update(await fs.readFile(index)).digest('hex');
    if(meta?.version!==config.template_version || meta.release_path!==config.api_release || meta.index_sha256!==hash) throw new Error('MANAGED_TEMPLATE_RELEASE_MISMATCH');
    return meta;
  });
}
/** Root-only preparation from canonical common-Test schema; no client dump input. */
export async function prepareTemplate(config:ManagedHostConfig) {
  const source=parse(await fs.readFile(config.source_env)),sourceUrl=new URL(source.DATABASE_URL??'');
  if(sourceUrl.pathname!=='/cerp_test') throw new Error('MANAGED_SOURCE_DATABASE_INVALID');
  await withDatabase(config.admin_database_url,'cerp_test',async client=>{
    if((await client.query("SELECT current_database()='cerp_test' AS ok")).rows[0]?.ok!==true) throw new Error('MANAGED_SOURCE_DATABASE_INVALID');
    if((await client.query('SELECT (SELECT count(*) FROM pg_foreign_server)+(SELECT count(*) FROM pg_foreign_table)+(SELECT count(*) FROM pg_subscription) AS n')).rows[0]?.n!=='0') throw new Error('MANAGED_SOURCE_HAS_REMOTE_LINKS');
  });
  await withDatabase(config.admin_database_url,'postgres',async client=>{
    if((await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[config.template_database])).rows.length) throw new Error('MANAGED_TEMPLATE_EXISTS');
    await client.query(`CREATE DATABASE ${sqlIdentifier(config.template_database)}`);
  });
  const directory=await checkedChild(config.control_root,'templates',config.template_version);await fs.mkdir(directory,{recursive:true,mode:0o700});
  const schema=path.join(directory,'schema.dump'),catalogues=path.join(directory,'catalogues.dump');
  await pgCommand(config,'pg_dump','cerp_test',['--format=custom','--schema-only','--file',schema]);
  await pgCommand(config,'pg_dump','cerp_test',['--format=custom','--data-only',...copiedCatalogues.flatMap(t=>['--table',`public.${t}`]),'--file',catalogues]);
  // Install triggers only after the initial catalogues/singletons exist. This
  // retains the canonical trigger definitions without generating business jobs
  // or invoking planning invalidation before its revision singleton is present.
  await pgCommand(config,'pg_restore',config.template_database,['--exit-on-error','--section=pre-data','--dbname',config.template_database,schema]);
  await pgCommand(config,'pg_restore',config.template_database,['--exit-on-error','--data-only','--dbname',config.template_database,catalogues]);
  await withDatabase(config.admin_database_url,config.template_database,async client=>{
    await client.query("INSERT INTO public.currencies(code,name) VALUES('EUR','Euro') ON CONFLICT DO NOTHING; INSERT INTO public.units(code,label) VALUES('u','Unité') ON CONFLICT DO NOTHING; INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING");
    await client.query(`INSERT INTO public.realtime_authorization_epoch(singleton,epoch) VALUES(true,0);
      INSERT INTO public.realtime_event_sequence_state(singleton,last_sequence,pruned_through) VALUES(true,0,0);
      INSERT INTO public.realtime_control_plane_v2_provenance(singleton,inherited_v1,source_v1_sha256,baseline_event_count,baseline_event_min,baseline_event_max,baseline_sequence_last,baseline_sequence_is_called,initial_last_sequence,initial_pruned_through)
      VALUES(true,false,NULL,0,NULL,NULL,1,false,0,0)`);
    // Initial generic families from the canonical Methods migration; source-Test
    // custom families and user provenance are deliberately not copied.
    await client.query(`INSERT INTO public.production_machine_families(code,libelle,description,programme_requis,est_favori,ordre_affichage,actif) VALUES
      ('T','Tournage CN','Tours à commande numérique.',true,true,10,true),
      ('F','Fraisage CN','Centres d''usinage à commande numérique.',true,true,20,true),
      ('TTRAD','Tour conventionnel','Tours traditionnels sans CN.',false,false,30,true),
      ('FTRAD','Fraisage conventionnel','Fraiseuses traditionnelles sans CN.',false,false,40,true),
      ('DECOUPE','Découpe','Débit et découpe matière.',false,false,50,true) ON CONFLICT DO NOTHING`);
  });
  await pgCommand(config,'pg_restore',config.template_database,['--exit-on-error','--section=post-data','--dbname',config.template_database,schema]);
  await withDatabase(config.admin_database_url,config.template_database,async client=>{
    await client.query('CREATE TABLE public.cerp_test_template_meta(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version text NOT NULL,release_path text NOT NULL,index_sha256 text NOT NULL)');
    const indexHash=createHash('sha256').update(await fs.readFile(path.join(config.api_release,'dist/index.js'))).digest('hex');
    await client.query('INSERT INTO public.cerp_test_template_meta(version,release_path,index_sha256) VALUES($1,$2,$3)',[config.template_version,config.api_release,indexHash]);
    await client.query('REVOKE ALL ON public.cerp_test_template_meta FROM PUBLIC,cerp_app');await assertBlankTemplate(client);
  });
  await verifyTemplate(config);
  await withDatabase(config.admin_database_url,'postgres',client=>client.query(`REVOKE CONNECT ON DATABASE ${sqlIdentifier(config.template_database)} FROM PUBLIC,cerp_app`));
  return {ready:true,template_version:config.template_version};
}
