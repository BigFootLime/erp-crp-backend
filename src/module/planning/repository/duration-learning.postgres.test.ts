import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import pool from '../../../config/database';
import {readCentralSnapshot} from './planning-central.repository';
import {readLearningSources,persistLearningObservation,readTaskObservations,recordDurationPredictions,readDurationAccuracy} from './duration-learning.repository';
import {runDurationLearningOnce} from '../services/duration-learning.worker';
import {repoCorrectExecution,repoValidateExecution,repoCompensateQuantity,repoCancelExecution} from '../../production/repository/production-execution.repository';
import {createCentralSimulation,applyCentralSimulation} from '../services/planning-central.service';
const isolated=process.env.CERP_DURATION_LEARNING_TEST==='1'&&process.env.CERP_E2E_ISOLATED==='1'
  &&process.env.DATABASE_URL==='postgresql://cerp_e2e@127.0.0.1:15432/cerp_test';
describe.skipIf(!isolated)('duration learning — isolated PostgreSQL',()=>{
  let actor:number,operator:number,piece:string,version:string,machine:string,otherMachine:string,calendar:string;
  const from='2026-09-01T00:00:00Z',to='2026-10-01T00:00:00Z';
  const audit=()=>({user_id:actor,role:'Directeur',user_role:'Directeur',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:'/planning/v2',page_key:'planning',client_session_id:null});
  beforeAll(async()=>{
    expect((await pool.query('SHOW data_directory')).rows[0].data_directory).toBe('/tmp/cerp-duration-learning-965-pg/data');
    const users=(await pool.query("SELECT id,username FROM public.users WHERE username IN ('KEENAN','E2E_PLANNER')")).rows;
    actor=Number(users.find(u=>u.username==='KEENAN').id);operator=Number(users.find(u=>u.username==='E2E_PLANNER').id);
    const suffix=randomUUID();operator=Number((await pool.query(`INSERT INTO public.users(username,password,email,role,status)
      SELECT $1,'DISABLED_TEST_CREDENTIAL',$2,role,status FROM public.users WHERE username='E2E_OPERATOR' RETURNING id`,['LEARN-'+suffix,suffix+'@example.invalid'])).rows[0].id);
    piece=randomUUID();version=randomUUID();machine=randomUUID();otherMachine=randomUUID();calendar=randomUUID();
    await pool.query("INSERT INTO public.production_machine_families(code,libelle) VALUES('LEARN','Learning fixture') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO public.pieces_techniques(id,client_id,name_piece,code_piece,designation,statut,en_fabrication,root_piece_technique_id,version_number,piece_critique)
      VALUES($1,'901',$2,$2,'Learning fixture','ACTIVE',true,$1,1,false)`,[piece,'LEARN-'+piece.slice(0,8)]);
    await pool.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,version_interne,code_metier,code_metier_normalise,document_requirements_policy)
      VALUES($1,$2,'A',$3,'BROUILLON',true,1,$3,$3,'NONE')`,[version,piece,'LEARN-'+piece.slice(0,8)]);
    await pool.query(`INSERT INTO public.programmation_calendars(id,code,label,timezone,working_days,day_start,day_end)
      VALUES($1,$2,'Learning calendar','Europe/Paris',ARRAY[1,2,3,4,5],'08:00','18:00')`,[calendar,'LEARN-'+calendar.slice(0,8)]);
    for(const id of [machine,otherMachine]){
      await pool.query(`INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by)
        VALUES($1,$2,'Learning machine','MILLING','ACTIVE',true,'LEARN',$3,$3)`,[id,'LEARN-'+id.slice(0,8),actor]);
      await pool.query('INSERT INTO public.planning_resource_calendars(resource_id,machine_id,calendar_id) VALUES($1,$2,$3)',['machine:'+id,id,calendar]);
    }
    await pool.query("UPDATE public.planning_central_settings SET activation='LEARN' WHERE singleton");
  });
  afterAll(async()=>{await pool.end();});
  let day=1;
  async function fixture(done=false){
    const tx=await pool.connect();await tx.query('BEGIN');try{
    const operation=randomUUID(),revision=randomUUID(),snapshot=JSON.stringify({operations:[{phase:10,machine_family_code:'LEARN',type_operation:'FRAISAGE'}]});
    const sha=createHash('sha256').update(snapshot).digest('hex');
    const of=Number((await tx.query(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,quantite_lancee,statut,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_readiness,created_by)
      VALUES($1,$2,$3,10,'BROUILLON',$4,$5,now(),'INCOMPLETE',$6) RETURNING id`,['LEARN-'+operation.slice(0,8),piece,version,snapshot,sha,actor])).rows[0].id);
    await tx.query('INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,$5)',[of,version,snapshot,sha,actor]);
    await tx.query(`INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,snapshot,snapshot_sha256,author_user_id,statut) VALUES($1,$2,0,'R00',$3,$4,$5,'ACTIVE')`,[revision,of,snapshot,sha,actor]);
    await tx.query(`INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation,machine_id,machine_family_code,tp,tf_unit,qte,coef)
      VALUES($1,$2,$3,10,'Learning operation',$4,'LEARN',1,0.2,1,1)`,[operation,of,revision,machine]);
    const pointage=randomUUID(),quantity=randomUUID(),date=`2026-08-${String(day++).padStart(2,'0')}`;
    if(done){
      await tx.query(`INSERT INTO public.production_pointages(id,of_id,operation_id,machine_id,operator_user_id,time_type,activity_code,start_ts,end_ts,status,validated_at,validated_by,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,'MACHINE','PRODUCTION',$6,$7,'DONE',now(),$8,$5,$5)`,[pointage,of,operation,machine,operator,date+'T08:00:00Z',date+'T09:00:00Z',actor]);
      await tx.query(`INSERT INTO public.production_quantity_declarations(id,pointage_id,of_id,operation_id,qty_good,declared_by)
        VALUES($1,$2,$3,$4,10,$5)`,[quantity,pointage,of,operation,operator]);
      await tx.query("UPDATE public.of_operations SET status='DONE',ended_at=$2 WHERE id=$1",[operation,date+'T09:00:00Z']);
      await tx.query('UPDATE public.ordres_fabrication SET quantite_bonne=10 WHERE id=$1',[of]);
    }
    await tx.query('COMMIT');return {of,operation,pointage,quantity,date};
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  }
  const task=async(id:string)=>(await readCentralSnapshot({from,to,limit:1000})).tasks.find(t=>t.operationId===id)!;
  const drain=async()=>{for(let i=0;i<30;i++){if(!await runDurationLearningOnce())return;}throw new Error('learning queue did not drain');};
  it('learns, ignores its own example, estimates alternate machines, invalidates and revalidates a correction',async()=>{
    const completed=await fixture(true),pending=await fixture();await drain();
    expect((await task(pending.operation)).estimate).toMatchObject({provenance:'HISTORY',observations:1,unitMinutes:11,setupMinutes:60});
    expect((await task(completed.operation)).estimate?.observations).toBe(0);
    expect((await task(pending.operation)).resourceEstimates?.['machine:'+otherMachine]).toMatchObject({provenance:'ROUTING',unitMinutes:12});
    const command={id:completed.pointage,patch:{end_ts:completed.date+'T08:30:00Z'},correction_reason:'Correct duration',actorRole:'Directeur',audit:audit(),idempotencyKey:randomUUID()};
    const [corrected,replayed]=await Promise.all([repoCorrectExecution(command),repoCorrectExecution(command)]);
    expect(replayed.id).toBe(corrected.id);
    expect((await task(pending.operation)).estimate?.observations).toBe(0);
    await drain();expect((await task(pending.operation)).estimate?.observations).toBe(0);
    await repoValidateExecution({id:corrected.id,note:null,actorRole:'Directeur',audit:audit()});await drain();
    expect((await task(pending.operation)).estimate).toMatchObject({observations:1,unitMinutes:10.5});
    expect((await readTaskObservations(pool,pending.operation,0,20))?.items.filter(i=>i.used)).toHaveLength(1);
    expect((await pool.query('SELECT validated_at,status FROM public.production_pointages WHERE id=$1',[completed.pointage])).rows[0]).toMatchObject({status:'CORRECTED'});
    const before=await pool.query('SELECT count(*)::int AS n FROM public.planning_estimation_observations WHERE operation_id=$1',[completed.operation]);
    const source=(await readLearningSources(pool,[completed.operation]))[0];await persistLearningObservation(pool,source);await persistLearningObservation(pool,source);
    expect((await pool.query('SELECT count(*)::int AS n FROM public.planning_estimation_observations WHERE operation_id=$1',[completed.operation])).rows).toEqual(before.rows);
  });
  it('compensates quantities once and removes the learned contribution immediately',async()=>{
    const f=await fixture(true);await drain();const key=randomUUID();
    const first=await repoCompensateQuantity({id:f.quantity,reason:'Quantity entered twice',idempotencyKey:key,audit:audit()});
    expect(await repoCompensateQuantity({id:f.quantity,reason:'Quantity entered twice',idempotencyKey:key,audit:audit()})).toEqual(first);
    expect((await pool.query('SELECT validated_at FROM public.planning_estimation_observations WHERE operation_id=$1',[f.operation])).rows.every(r=>r.validated_at===null)).toBe(true);
    await drain();expect((await pool.query('SELECT excluded_reason FROM public.planning_estimation_observations WHERE operation_id=$1',[f.operation])).rows[0].excluded_reason).toBe('UNATTRIBUTABLE_QUANTITY_OR_TIME');
  });
  it('rejects stale simulations after an observation changes without writing commitments',async()=>{
    const f=await fixture();await drain();const snapshot=await readCentralSnapshot({from,to,limit:1000}),t=snapshot.tasks.find(t=>t.operationId===f.operation)!;
    const simulation=await createCentralSimulation({from,to,revision:snapshot.revision,changes:[{taskId:t.id,expectedVersion:t.version,earliestStart:from}]},audit(),randomUUID());
    await fixture(true);await drain();
    await expect(applyCentralSimulation(simulation.id,snapshot.revision,audit(),randomUUID())).rejects.toMatchObject({code:'PLANNING_SIMULATION_OBSOLETE'});
    expect((await task(f.operation)).committed).toBeNull();
  });
  it('cancels a validated pointage once and preserves the original measurements',async()=>{
    const f=await fixture(true);await drain();
    const before=(await pool.query('SELECT start_ts,end_ts,validated_at FROM public.production_pointages WHERE id=$1',[f.pointage])).rows[0];
    const command={id:f.pointage,reason:'Wrong run',actorRole:'Directeur',audit:audit()};
    await repoCancelExecution(command);await repoCancelExecution(command);await drain();
    expect((await pool.query('SELECT start_ts,end_ts,validated_at FROM public.production_pointages WHERE id=$1',[f.pointage])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM public.production_pointage_events WHERE pointage_id=$1 AND event_type='CANCEL'",[f.pointage])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT excluded_reason FROM public.planning_estimation_observations WHERE operation_id=$1',[f.operation])).rows[0].excluded_reason).toBe('QUANTITY_WITHOUT_PRODUCTIVE_SEGMENT');
  });
  it('retains failed jobs and retries without partial observations',async()=>{
    await drain();const f=await fixture(true);
    await pool.query(`ALTER TABLE public.planning_estimation_observations ADD CONSTRAINT duration_test_failure CHECK(operation_id<>'${f.operation}'::uuid) NOT VALID`);
    try {
      await expect(runDurationLearningOnce()).rejects.toBeDefined();
      expect((await pool.query('SELECT attempts FROM public.planning_learning_jobs WHERE operation_id=$1',[f.operation])).rows[0].attempts).toBe(1);
      expect((await pool.query('SELECT id FROM public.planning_estimation_observations WHERE operation_id=$1',[f.operation])).rowCount).toBe(0);
    }finally{await pool.query('ALTER TABLE public.planning_estimation_observations DROP CONSTRAINT duration_test_failure');}
    await drain();
    expect((await pool.query('SELECT id FROM public.planning_estimation_observations WHERE operation_id=$1 AND validated_at IS NOT NULL',[f.operation])).rowCount).toBe(1);
  });
  it('freezes a forecast before execution and evaluates comparable completed runs',async()=>{
    const f=await fixture();await drain();
    const snapshot=await readCentralSnapshot({from,to,limit:1000});
    snapshot.tasks=snapshot.tasks.filter(t=>t.operationId===f.operation);
    await recordDurationPredictions(pool,snapshot);
    const before=(await pool.query('SELECT * FROM public.planning_duration_predictions WHERE operation_id=$1',[f.operation])).rows[0];
    expect(before).toBeDefined();
    snapshot.tasks[0].estimate!.unitMinutes=999;await recordDurationPredictions(pool,snapshot);
    expect((await pool.query('SELECT * FROM public.planning_duration_predictions WHERE operation_id=$1',[f.operation])).rows[0]).toEqual(before);
    const evaluatedBefore=(await readDurationAccuracy(pool)).evaluated_operations;
    const start=new Date(Date.now()+3600000).toISOString(),end=new Date(Date.now()+7200000).toISOString();
    await pool.query(`INSERT INTO public.production_pointages(id,of_id,operation_id,machine_id,operator_user_id,time_type,activity_code,start_ts,end_ts,status,validated_at,validated_by,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,'MACHINE','PRODUCTION',$6,$7,'DONE',now(),$8,$5,$5)`,[f.pointage,f.of,f.operation,machine,operator,start,end,actor]);
    await pool.query('INSERT INTO public.production_quantity_declarations(id,pointage_id,of_id,operation_id,qty_good,declared_by) VALUES($1,$2,$3,$4,10,$5)',[f.quantity,f.pointage,f.of,f.operation,operator]);
    await pool.query("UPDATE public.of_operations SET status='DONE',started_at=$2,ended_at=$3 WHERE id=$1",[f.operation,start,end]);await drain();
    expect((await readDurationAccuracy(pool)).evaluated_operations).toBe(evaluatedBefore+1);
  });
  it('falls back to routing when learning is disabled and retains observations',async()=>{
    const f=await fixture();await drain();
    const count=(await pool.query('SELECT count(*)::int AS n FROM public.planning_estimation_observations')).rows[0].n;
    await pool.query("UPDATE public.planning_central_settings SET activation='EXECUTE' WHERE singleton");
    try {
      expect((await task(f.operation)).estimate).toMatchObject({provenance:'ROUTING',unitMinutes:12,observations:0});
      expect((await readTaskObservations(pool,f.operation,0,20))?.items.every(item=>!item.used)).toBe(true);
      expect((await pool.query('SELECT count(*)::int AS n FROM public.planning_estimation_observations')).rows[0].n).toBe(count);
    }finally{await pool.query("UPDATE public.planning_central_settings SET activation='LEARN' WHERE singleton");}
  });
  it('refuses quantity compensation when a quality record already uses the operation',async()=>{
    const f=await fixture(true);await drain();
    await pool.query("INSERT INTO public.of_quality_logs(of_id,of_operation_id,user_id,kind,comment) VALUES($1,$2,$3,'CONTROL','Synthetic quality control')",[f.of,f.operation,actor]);
    await expect(repoCompensateQuantity({id:f.quantity,reason:'Must use quality workflow',idempotencyKey:randomUUID(),audit:audit()}))
      .rejects.toMatchObject({code:'PRODUCTION_QUANTITY_DOWNSTREAM_LOCKED'});
    expect((await pool.query('SELECT id FROM public.production_quantity_declarations WHERE compensates_id=$1',[f.quantity])).rowCount).toBe(0);
  });
});
