const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {connectIsolated}=require('./bootstrap-isolated.cjs');
const {planningFixture}=require('./planning-fixture.cjs');
const runtime=path.resolve(__dirname,'../../../performance-runtime');
fs.mkdirSync(runtime,{recursive:true});
const credentialPath=path.join(runtime,'credentials.json');
if(!fs.existsSync(credentialPath))fs.writeFileSync(credentialPath,JSON.stringify({password:randomBytes(24).toString('base64url'),jwt:randomBytes(48).toString('hex')}),{mode:0o600,flag:'wx'});
async function main(){
  const credentials=JSON.parse(fs.readFileSync(credentialPath,'utf8'));
  const password=await require('bcryptjs').hash(credentials.password,10);
  const db=await connectIsolated();
  const uuid=(kind,n)=>`${kind.toString(16).padStart(8,'0')}-0970-4000-8000-${n.toString(16).padStart(12,'0')}`;
  const fixture=planningFixture();
  try{
    if(Number((await db.query('SELECT count(*) FROM public.of_operations')).rows[0].count))throw new Error('Fixture requires an empty operation table');
    await db.query('BEGIN');
    let actor;
    for(let i=1;i<=20;i++){
      const role=i<=16?'Secretaire':'Responsable Programmation';
      const user=(await db.query(`INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin)
        VALUES($1,$2,'Synthetic',$1,$3,$4,'Active',false) RETURNING id`,[`PERF970_${String(i).padStart(2,'0')}`,password,`perf970-${i}@example.invalid`,role])).rows[0].id;
      await db.query('INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,$2)',[user,role]);
      if(i===17)actor=user;
    }
    const clientId=(await db.query("INSERT INTO public.clients(client_id,company_name,status) VALUES('901','Performance synthetic','client') RETURNING client_id")).rows[0].client_id;
    const piece=uuid(972,1),version=uuid(973,1),calendar=uuid(974,1);
    await db.query(`INSERT INTO public.pieces_techniques(id,client_id,name_piece,code_piece,designation,statut,en_fabrication,root_piece_technique_id,version_number,piece_critique)
      VALUES($1,$2,'PERF970','PERF970','Synthetic performance fixture','ACTIVE',1,$1,1,false)`,[piece,clientId]);
    await db.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,version_interne,code_metier,code_metier_normalise,document_requirements_policy)
      VALUES($1,$2,'C','PERF970','BROUILLON',true,1,'PERF970','PERF970','NONE')`,[version,piece]);
    await db.query(`INSERT INTO public.programmation_calendars(id,code,label,timezone,working_days,day_start,day_end)
      VALUES($1,'PERF970','Synthetic weekday shifts','Europe/Paris',ARRAY[1,2,3,4,5],'08:00','16:00')`,[calendar]);
    for(let i=0;i<5;i++)await db.query('INSERT INTO public.production_machine_families(code,libelle) VALUES($1,$2)',[`PERF_${i}`,`Synthetic family ${i}`]);
    for(const [i,r] of fixture.resources.entries()){
      await db.query(`INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by)
        VALUES($1,$2,$3,'MILLING','ACTIVE',true,$4,$5,$5)`,[r.id.slice(8),`PERF970-M${i+1}`,r.label,`PERF_${i%5}`,actor]);
      await db.query('INSERT INTO public.planning_resource_calendars(resource_id,machine_id,calendar_id) VALUES($1,$2,$3)',[r.id,r.id.slice(8),calendar]);
    }
    for(let ofIndex=0;ofIndex<1000;ofIndex++){
      const ops=fixture.tasks.slice(ofIndex*10,ofIndex*10+10),family=`PERF_${ofIndex%5}`;
      const snapshot=JSON.stringify({operations:ops.map((t,i)=>({phase:(i+1)*10,machine_family_code:family}))});
      const sha=createHash('sha256').update(snapshot).digest('hex');
      const of=(await db.query(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,quantite_lancee,statut,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_readiness,created_by)
        VALUES($1,$2,$3,10,'BROUILLON',$4,$5,now(),'INCOMPLETE',$6) RETURNING id`,[ops[0].ofNumber,piece,version,snapshot,sha,actor])).rows[0].id;
      await db.query('INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,$5)',[of,version,snapshot,sha,actor]);
      const revision=uuid(975,ofIndex+1);
      await db.query("INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,snapshot,snapshot_sha256,author_user_id,statut) VALUES($1,$2,0,'R00',$3,$4,$5,'ACTIVE')",[revision,of,snapshot,sha,actor]);
      await db.query(`INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation,machine_id,machine_family_code,tp,tf_unit,qte,coef)
        SELECT x.id,$2,$3,x.phase,x.label,x.machine,$4,0,x.minutes/600.0,1,1
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,phase int,label text,machine uuid,minutes numeric)`,
        [JSON.stringify(ops.map((t,i)=>({id:t.operationId,phase:(i+1)*10,label:t.label,machine:t.resourceIds[0].slice(8),minutes:t.estimate.remainingMinutes}))),of,revision,family]);
      // Eighty percent of OFs occupy complete dependency chains. Twenty percent remain in the backlog.
      if(ofIndex%5!==0){
        const day=new Date('2026-09-01T06:00:00Z');
        for(let n=0;n<Math.floor(ofIndex/50);n++){
          do{day.setUTCDate(day.getUTCDate()+1);}while([0,6].includes(day.getUTCDay()));
        }
        await db.query(`INSERT INTO public.planning_events(id,kind,status,priority,of_id,of_operation_id,title,start_ts,end_ts,machine_id,created_by,updated_by)
          SELECT x.id,'OF_OPERATION','PLANNED','NORMAL',$2,x.operation,x.title,x.start_ts,x.end_ts,x.machine,$3,$3
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,operation uuid,title text,start_ts timestamptz,end_ts timestamptz,machine uuid)`,
          [JSON.stringify(ops.map((t,i)=>({id:uuid(976,ofIndex*10+i+1),operation:t.operationId,title:t.label,start_ts:new Date(+day+i*45*60000).toISOString(),end_ts:new Date(+day+(i*45+30)*60000).toISOString(),machine:t.resourceIds[0].slice(8)}))),of,actor]);
      }
      if(ofIndex%100===0)console.log(`Seeded ${ofIndex+1}/1000 synthetic OFs`);
    }
    await db.query('COMMIT');
    await db.query('ANALYZE');
    fs.writeFileSync(path.join(runtime,'fixture.json'),JSON.stringify({version:'970-v1',engineHash:fixture.hash,resources:50,operations:10000,ofs:1000,readers:16,planners:4,committed:8000,backlog:2000},null,2));
    console.log('Synthetic planning fixture ready');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
