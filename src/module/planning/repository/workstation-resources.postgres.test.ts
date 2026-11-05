import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {Client} from 'pg';
import {readFile} from 'node:fs/promises';
import {readOperationQualifications} from './planning-operation-resources.repository';
import {assertOperationResourceCompatible} from './planning.repository';
import {readCentralResources} from './planning-central.repository';
import {assignGeneratedWorkstationDefaults,prepareOperationResources} from '../../production/repository/workstation-defaults.repository';

const url='postgresql://cerp_fixture@127.0.0.1:55684/cerp_workstations_1834';
const enabled=process.env.CERP_WORKSTATION_TEST_URL===url;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
describe.skipIf(!enabled)('ressources de travail — PostgreSQL isolé, aucun engagement',()=>{
 const db=new Client({connectionString:url});
 beforeAll(async()=>{
  await db.connect();
  expect((await db.query('SELECT current_database() AS db,current_user AS role')).rows[0]).toEqual({db:'cerp_workstations_1834',role:'cerp_fixture'});
  expect((await db.query('SHOW data_directory')).rows[0].data_directory).toBe('/tmp/cerp-workstations-1834-pg');
  await db.query(`CREATE TABLE IF NOT EXISTS public.postes(id uuid PRIMARY KEY,code text,label text,machine_id uuid,is_active boolean,archived_at timestamptz);
   CREATE TABLE IF NOT EXISTS public.machines(id uuid PRIMARY KEY,code text,name text,machine_family_code text,status text,is_available boolean,scheduling_enabled boolean,archived_at timestamptz);
   CREATE TABLE IF NOT EXISTS public.production_maintenance_holds(machine_id uuid,resolved_at timestamptz);
   CREATE TABLE IF NOT EXISTS public.ordres_fabrication(id bigint PRIMARY KEY,piece_technique_id uuid,technical_snapshot jsonb);
   CREATE TABLE IF NOT EXISTS public.of_operations(id uuid PRIMARY KEY,of_id bigint,phase integer,poste_id uuid,machine_id uuid,machine_family_code text,source_piece_operation_id uuid,status text DEFAULT 'TODO');
   CREATE TABLE IF NOT EXISTS public.pieces_techniques_operations(id uuid PRIMARY KEY,type_operation text);
   CREATE TABLE IF NOT EXISTS public.erp_settings(key text PRIMARY KEY,value_json jsonb,updated_at timestamptz DEFAULT now());
   CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,name text,surname text,username text);
   CREATE TABLE IF NOT EXISTS public.piece_version_programming_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),piece_technique_version_id uuid,assignee_id integer,estimated_hours numeric,status text NOT NULL DEFAULT 'TODO',program_reference text,completed_at timestamptz,completed_by integer,updated_by integer,updated_at timestamptz DEFAULT now(),of_id bigint,
     CHECK(status IN ('TODO','DONE')),CHECK(status<>'DONE' OR (length(trim(program_reference))>0 AND completed_at IS NOT NULL AND completed_by IS NOT NULL)));
   CREATE TABLE IF NOT EXISTS public.programmations(programmer_user_id integer,archived_at timestamptz);
   CREATE TABLE IF NOT EXISTS public.planning_central_settings(singleton boolean PRIMARY KEY,revision bigint,workshop_calendar_id uuid);
   CREATE TABLE IF NOT EXISTS public.programmation_calendars(id uuid PRIMARY KEY,active boolean,timezone text,working_days integer[],day_start time,day_end time,updated_at timestamptz DEFAULT now());
   CREATE TABLE IF NOT EXISTS public.planning_resource_calendars(resource_id text,user_id integer,calendar_id uuid,version integer,display_label text);
   ALTER TABLE public.planning_resource_calendars ADD COLUMN IF NOT EXISTS display_label text;
   CREATE TABLE IF NOT EXISTS public.planning_resource_absences(resource_id text,start_ts timestamptz,end_ts timestamptz);
   CREATE TABLE IF NOT EXISTS public.planning_events(id uuid,machine_id uuid,poste_id uuid,of_operation_id uuid,kind text,status text,start_ts timestamptz,end_ts timestamptz,archived_at timestamptz,title text,description text);
   CREATE TABLE IF NOT EXISTS public.programmation_calendar_closures(calendar_id uuid,start_date date,end_date date);`);
  await db.query(await readFile('db/patches/20261105_programming_progress_1834.sql','utf8'));
 });
 afterAll(async()=>{await db.end();});
 beforeEach(async()=>{
  await db.query(`TRUNCATE public.postes,public.machines,public.production_maintenance_holds,public.ordres_fabrication,public.of_operations,public.pieces_techniques_operations,
   public.erp_settings,public.users,public.piece_version_programming_tasks,public.programmations,public.planning_central_settings,public.programmation_calendars,public.planning_resource_calendars,public.planning_resource_absences,public.planning_events,public.programmation_calendar_closures`);
  await db.query('INSERT INTO public.postes VALUES($1,\'DECOUPE\',\'Découpe\',NULL,true,NULL),($2,\'CONTROLE\',\'Contrôle\',NULL,true,NULL),($3,\'EMBALLAGE\',\'Emballage\',NULL,true,NULL)',[id(1),id(2),id(3)]);
  await db.query('INSERT INTO public.machines VALUES($1,\'F1\',\'Fraiseuse\',\'F\',\'ACTIVE\',true,true,NULL)',[id(4)]);
  await db.query('INSERT INTO public.ordres_fabrication VALUES(1,$1,$2::jsonb)',[id(10),JSON.stringify({operations:[{phase:10,type_operation:'DECOUPE'},{phase:20,type_operation:'CONTROLE'},{phase:30,type_operation:'FRAISAGE'}]})]);
  await db.query('INSERT INTO public.of_operations(id,of_id,phase,poste_id,machine_family_code,source_piece_operation_id) VALUES($1,1,10,$2,\'DECOUPE\',$1),($3,1,20,NULL,NULL,$3),($4,1,30,NULL,\'F\',$4)',[id(11),id(1),id(12),id(13)]);
 });
 it('accepte le poste de découpe même avec sa famille technique DECOUPE',async()=>{
  const rows=await readOperationQualifications(db,[id(11)],{});
  expect(rows[0].eligible).toEqual(['poste:'+id(1)]);
  await expect(assertOperationResourceCompatible({tx:db,of_operation_id:id(11),resource:{poste_id:id(1),machine_id:null}})).resolves.toBeUndefined();
 });
 it('reprend le poste habituel sans exiger une affectation préalable de chaque OF',async()=>{
  expect((await readOperationQualifications(db,[id(12)],{CONTROLE:id(2)}))[0].eligible).toEqual(['poste:'+id(2)]);
  await expect(assertOperationResourceCompatible({tx:db,of_operation_id:id(12),resource:{poste_id:id(2),machine_id:null}})).resolves.toBeUndefined();
  expect((await db.query('SELECT poste_id FROM public.of_operations WHERE id=$1',[id(12)])).rows[0].poste_id).toBeNull();
 });
 it('refuse un poste arbitraire différent du poste habituel',async()=>{
  await expect(assertOperationResourceCompatible({tx:db,of_operation_id:id(12),resource:{poste_id:id(3),machine_id:null}})).rejects.toMatchObject({code:'PLANNING_MANUAL_POSTE_REQUIRED'});
 });
 it('conserve la qualification des machines pour l’usinage',async()=>{
  const rows=await readOperationQualifications(db,[id(13)],{CONTROLE:id(2)});
  expect(rows[0].eligible).toEqual(['machine:'+id(4)]);
  await expect(assertOperationResourceCompatible({tx:db,of_operation_id:id(13),resource:{poste_id:id(2),machine_id:null}})).rejects.toMatchObject({code:'PLANNING_MACHINE_QUALIFICATION_REQUIRED'});
 });
 it('montre le poste habituel dès la préparation et signale une mauvaise famille de machine',async()=>{
  const operations=[{id:id(12),phase:20,designation:'CONTROLE',type_operation:'CONTROLE',machine_family_code:null},
    {id:id(13),phase:30,designation:'TOURNAGE',type_operation:'TOURNAGE',machine_family_code:'T',machine_id:id(4)}];
  const result=await prepareOperationResources(db,operations,1);
  expect(result[0]).toMatchObject({resource:'Contrôle',source:'DEFAULT',issue:null});
  expect(result[1].issue).toContain('ne correspond pas à la famille');
  expect((await db.query('SELECT count(*)::int AS n FROM public.planning_events')).rows[0].n).toBe(0);
 });
 it('ne remplace pas silencieusement un poste explicitement affecté puis archivé',async()=>{
  await db.query('UPDATE public.postes SET archived_at=now() WHERE id=$1',[id(1)]);
  expect((await readOperationQualifications(db,[id(11)],{DECOUPE:id(3)}))[0].eligible).toEqual([]);
 });
 it('renseigne les postes des nouvelles opérations sans remplacer une affectation existante',async()=>{
  await db.query('INSERT INTO public.pieces_techniques_operations VALUES($1,\'DECOUPE\'),($2,\'CONTROLE\'),($3,\'FRAISAGE\')',[id(11),id(12),id(13)]);
  await assignGeneratedWorkstationDefaults(db,1);
  expect((await db.query('SELECT poste_id FROM public.of_operations ORDER BY phase')).rows.map(row=>row.poste_id)).toEqual([id(1),id(2),null]);
 });
 it('utilise le calendrier atelier même si plusieurs calendriers sont actifs',async()=>{
  await db.query('INSERT INTO public.programmation_calendars(id,active,timezone,working_days,day_start,day_end) VALUES($1,true,\'Europe/Paris\',ARRAY[1,2,3,4,5],\'08:00\',\'16:00\'),($2,true,\'Europe/Paris\',ARRAY[1],\'10:00\',\'11:00\')',[id(21),id(22)]);
  await db.query('INSERT INTO public.planning_central_settings VALUES(true,1,$1)',[id(21)]);
  const resource=(await readCentralResources(db,'2026-11-09T00:00:00Z','2026-11-10T00:00:00Z')).find(row=>row.id==='poste:'+id(2));
  expect(resource?.calendarConfigured).toBe(true);expect(resource?.availability.length).toBeGreaterThan(0);
 });
 it('enregistre les paliers sans déclarer de programme réalisé',async()=>{
  await db.query('INSERT INTO public.piece_version_programming_tasks(id,progress_percent) VALUES($1,25)',[id(30)]);
  expect((await db.query('SELECT status,progress_percent,completed_at FROM public.piece_version_programming_tasks')).rows[0]).toMatchObject({status:'TODO',progress_percent:25,completed_at:null});
  await expect(db.query('UPDATE public.piece_version_programming_tasks SET progress_percent=100 WHERE id=$1',[id(30)])).rejects.toMatchObject({code:'23514'});
 });
 it('préserve les anciens clients qui terminent un programme sans envoyer le pourcentage',async()=>{
  await db.query('INSERT INTO public.piece_version_programming_tasks(id,progress_percent) VALUES($1,75)',[id(30)]);
  await db.query('UPDATE public.piece_version_programming_tasks SET status=\'DONE\',program_reference=\'CN-001\',completed_at=now(),completed_by=1 WHERE id=$1',[id(30)]);
  expect((await db.query('SELECT progress_percent FROM public.piece_version_programming_tasks')).rows[0].progress_percent).toBe(100);
  expect((await db.query('SELECT count(*)::int AS n FROM public.planning_events')).rows[0].n).toBe(0);
 });
});
