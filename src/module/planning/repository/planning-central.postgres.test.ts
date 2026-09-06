import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pool from "../../../config/database";
import { readCentralResources, readCentralSnapshot } from "./planning-central.repository";
import { applyCentralSimulation, createCentralSimulation } from "../services/planning-central.service";
import type { AuditContext } from "./planning.repository";
const isolated=process.env.CERP_E2E_ISOLATED==="1" && process.env.DATABASE_URL==="postgresql://cerp_e2e@127.0.0.1:55636/cerp_test";
const from="2026-09-07T06:00:00.000Z",to="2026-09-14T18:00:00.000Z";
describe.skipIf(!isolated)("Planning central — PostgreSQL réel isolé",()=>{
  let actor:number;
  const audit=():AuditContext=>({user_id:actor,role:"Responsable Programmation",ip:null,user_agent:null,device_type:null,os:null,browser:null,path:"/planning/v2",page_key:"planning",client_session_id:null});
  beforeAll(async()=>{
    const identity=await pool.query("SHOW data_directory");
    expect(identity.rows[0].data_directory).toBe("/tmp/cerp-planning-20260906-pg/data");
    actor=Number((await pool.query("SELECT id FROM public.users WHERE username='E2E_PLANNER'")).rows[0].id);
    await pool.query("UPDATE public.planning_central_settings SET activation='COMMIT'");
  });
  afterAll(()=>pool.end());
  async function fixture() {
    const suffix=randomUUID().slice(0,8),piece=randomUUID(),version=randomUUID(),task=randomUUID(),calendar=randomUUID();
    const user=Number((await pool.query(`INSERT INTO public.users(username,password,email,role,status)
      VALUES($1,'DISABLED_TEST_CREDENTIAL',$2,'Responsable Programmation','Active') RETURNING id`,["PLANNING-"+suffix,suffix+"@example.invalid"])).rows[0].id);
    await pool.query(`INSERT INTO public.pieces_techniques(id,client_id,name_piece,code_piece,designation,statut,en_fabrication,root_piece_technique_id,version_number,piece_critique)
      VALUES($1,'901',$2,$2,'Pièce synthétique planning','ACTIVE',true,$1,1,false)`,[piece,"P717-"+suffix]);
    await pool.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,version_interne,code_metier,code_metier_normalise,document_requirements_policy)
      VALUES($1,$2,'C',$3,'BROUILLON',true,1,$3,$3,'NONE')`,[version,piece,"P717-"+suffix]);
    await pool.query(`INSERT INTO public.programmation_calendars(id,code,label,timezone,working_days,day_start,day_end)
      VALUES($1,$2,'Calendrier synthétique','Europe/Paris',ARRAY[1,2,3,4,5],'08:00','16:00')`,[calendar,"P717-"+suffix]);
    await pool.query("INSERT INTO public.planning_resource_calendars(resource_id,user_id,calendar_id) VALUES($1,$2,$3)",["person:"+user,user,calendar]);
    await pool.query(`INSERT INTO public.piece_version_programming_tasks(id,piece_technique_version_id,assignee_id,estimated_hours,updated_by)
      VALUES($1,$2,$3,2,$3)`,[task,version,user]);
    return {task:"version-program:"+task,user,calendar,piece,version};
  }
  async function operationFixture() {
    const f=await fixture(),machine=randomUUID(),revision=randomUUID(),operations=[randomUUID(),randomUUID()];
    const snapshot=JSON.stringify({operations:[{phase:10,machine_family_code:"F"},{phase:20,machine_family_code:"F"}]}),sha=createHash("sha256").update(snapshot).digest("hex");
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(`INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by)
        VALUES($1,$2,'Machine planning synthétique','MILLING','ACTIVE',true,'F',$3,$3)`,[machine,"P717-M-"+machine.slice(0,8),actor]);
      await tx.query("INSERT INTO public.planning_resource_calendars(resource_id,machine_id,calendar_id) VALUES($1,$2,$3)",["machine:"+machine,machine,f.calendar]);
      const of=Number((await tx.query(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,quantite_lancee,statut,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_readiness,created_by)
        VALUES($1,$2,$3,10,'BROUILLON',$4,$5,now(),'INCOMPLETE',$6) RETURNING id`,["P717-OF-"+machine.slice(0,8),f.piece,f.version,snapshot,sha,actor])).rows[0].id);
      await tx.query("INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,$5)",[of,f.version,snapshot,sha,actor]);
      await tx.query("INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,snapshot,snapshot_sha256,author_user_id) VALUES($1,$2,0,'R00',$3,$4,$5)",[revision,of,snapshot,sha,actor]);
      for(let i=0;i<operations.length;i++) await tx.query(`INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation,machine_id,machine_family_code,tp,tf_unit,qte,coef)
        VALUES($1,$2,$3,$4,$5,$6,'F',1,0.1,1,1)`,[operations[i],of,revision,(i+1)*10,"Opération synthétique "+i,machine]);
      await tx.query("INSERT INTO public.planning_operation_dependencies(predecessor_id,successor_id) VALUES($1,$2)",operations.map(id=>"op:"+id));
      await tx.query("COMMIT");
      return {of,operations,machine,calendar:f.calendar};
    } catch(error) {await tx.query("ROLLBACK");throw error;} finally {tx.release();}
  }
  async function intent(taskId:string) {
    const snapshot=await readCentralSnapshot({from,to,limit:1000});
    const task=snapshot.tasks.find(t=>t.id===taskId)!;
    expect(task).toBeDefined();
    return {revision:snapshot.revision,from,to,changes:[{taskId,expectedVersion:task.version,earliestStart:from}]};
  }
  it("une simulation ne modifie aucun engagement ; application atomique et replay idempotent",async()=>{
    const f=await fixture(),input=await intent(f.task),key=randomUUID();
    const first=await createCentralSimulation(input,audit(),key);
    expect(first.result.feasible).toBe(true);
    const replay=await createCentralSimulation(input,audit(),key);
    expect(replay.id).toBe(first.id);
    expect((await pool.query("SELECT committed_start FROM public.planning_tasks WHERE id=$1",[f.task])).rows[0].committed_start).toBeNull();
    const applyKey=randomUUID();
    const outputs=await Promise.all([applyCentralSimulation(first.id,first.revision,audit(),applyKey),applyCentralSimulation(first.id,first.revision,audit(),applyKey)]);
    expect(outputs[0]).toEqual(outputs[1]);
    expect((await pool.query("SELECT committed_start FROM public.planning_tasks WHERE id=$1",[f.task])).rows[0].committed_start).not.toBeNull();
    expect(Number((await pool.query("SELECT count(*) FROM public.planning_command_idempotency WHERE command='apply' AND key=$1",[applyKey])).rows[0].count)).toBe(1);
  });
  it("un changement concurrent invalide l'aperçu sans écriture partielle",async()=>{
    const f=await fixture(),s=await createCentralSimulation(await intent(f.task),audit(),randomUUID());
    await pool.query("INSERT INTO public.planning_resource_absences(resource_id,start_ts,end_ts,reason) VALUES($1,$2,$3,'Absence synthétique')",
      ["person:"+f.user,from,"2026-09-07T12:00:00Z"]);
    await expect(applyCentralSimulation(s.id,s.revision,audit(),randomUUID())).rejects.toMatchObject({code:"PLANNING_SIMULATION_OBSOLETE"});
    expect((await pool.query("SELECT committed_start FROM public.planning_tasks WHERE id=$1",[f.task])).rows[0].committed_start).toBeNull();
  });
  it("crée une seule fois les deux créneaux canoniques d’un OF, puis permet leur déplacement",async()=>{
    const f=await operationFixture(),input=await intent("op:"+f.operations[0]);
    const s=await createCentralSimulation(input,audit(),randomUUID());
    expect(s.result.feasible).toBe(true);
    expect(s.result.changes.filter(change=>f.operations.some(id=>change.taskId==="op:"+id))).toHaveLength(2);
    const key=randomUUID();
    await applyCentralSimulation(s.id,s.revision,audit(),key);
    await applyCentralSimulation(s.id,s.revision,audit(),key);
    const events=await pool.query("SELECT id,of_operation_id,start_ts,end_ts FROM public.planning_events WHERE of_id=$1 ORDER BY start_ts",[f.of]);
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every(event=>typeof event.id==="string")).toBe(true);
    expect(new Date(events.rows[1].start_ts).getTime()).toBeGreaterThanOrEqual(new Date(events.rows[0].end_ts).getTime());
    const next=await intent("op:"+f.operations[0]);
    next.changes[0].earliestStart="2026-09-08T06:00:00.000Z";
    const moved=await createCentralSimulation(next,audit(),randomUUID());
    await applyCentralSimulation(moved.id,moved.revision,audit(),randomUUID());
    const updated=await pool.query("SELECT id,start_ts FROM public.planning_events WHERE of_id=$1 ORDER BY start_ts",[f.of]);
    expect(updated.rows.map(event=>event.id)).toEqual(events.rows.map(event=>event.id));
    expect(new Date(updated.rows[0].start_ts).toISOString()).toBe("2026-09-08T06:00:00.000Z");
  });
  it("la même clé ne peut pas être réutilisée pour un contenu différent",async()=>{
    const f=await fixture(),input=await intent(f.task),key=randomUUID();
    await createCentralSimulation(input,audit(),key);
    await expect(createCentralSimulation({...input,from:"2026-09-08T06:00:00Z"},audit(),key)).rejects.toMatchObject({code:"IDEMPOTENCY_KEY_REUSED"});
  });
  it("l’automatique choisit une capacité qualifiée et conserve le prérequis déjà engagé hors fenêtre",async()=>{
    const f=await operationFixture(),first=await createCentralSimulation(await intent("op:"+f.operations[0]),audit(),randomUUID());
    await applyCentralSimulation(first.id,first.revision,audit(),randomUUID());
    const previous=(await pool.query("SELECT start_ts,end_ts FROM public.planning_events WHERE of_operation_id=$1",[f.operations[0]])).rows[0];
    const input=await intent("op:"+f.operations[1]);
    const next={...input,from:"2026-09-10T06:00:00.000Z",to:"2026-09-20T18:00:00.000Z",
      changes:input.changes.map(change=>({...change,earliestStart:"2026-09-10T06:00:00.000Z",autoAssign:true}))};
    const proposal=await createCentralSimulation(next,audit(),randomUUID());
    expect(proposal.result.feasible).toBe(true);
    expect(proposal.result.changes).toHaveLength(1);
    expect(proposal.result.changes[0].taskId).toBe("op:"+f.operations[1]);
    expect(proposal.result.changes[0].after.start).toBe(next.from);
    await applyCentralSimulation(proposal.id,proposal.revision,audit(),randomUUID());
    expect((await pool.query("SELECT start_ts,end_ts FROM public.planning_events WHERE of_operation_id=$1",[f.operations[0]])).rows[0]).toEqual(previous);
  });
  it("une machine devenue indisponible invalide la proposition sans créer de créneau",async()=>{
    const f=await operationFixture(),s=await createCentralSimulation(await intent("op:"+f.operations[0]),audit(),randomUUID());
    await pool.query("UPDATE public.machines SET is_available=false WHERE id=$1",[f.machine]);
    await expect(applyCentralSimulation(s.id,s.revision,audit(),randomUUID())).rejects.toMatchObject({code:"PLANNING_SIMULATION_OBSOLETE"});
    expect((await pool.query("SELECT id FROM public.planning_events WHERE of_id=$1",[f.of])).rows).toHaveLength(0);
  });
  it("reprend l’ordre de gamme existant lorsqu’aucun lien explicite n’est encore défini",async()=>{
    const f=await operationFixture();
    await pool.query("DELETE FROM public.planning_operation_dependencies WHERE predecessor_id=$1",["op:"+f.operations[0]]);
    const s=await createCentralSimulation(await intent("op:"+f.operations[0]),audit(),randomUUID());
    expect(s.result.feasible).toBe(true);
    const changes=f.operations.map(id=>s.result.changes.find(change=>change.taskId==="op:"+id)!);
    expect(changes.every(Boolean)).toBe(true);
    expect(Date.parse(changes[1].after.start)).toBeGreaterThanOrEqual(Date.parse(changes[0].after.end));
  });
  it("reprend le calendrier atelier unique sans inventer de capacité lorsqu’il manque",async()=>{
    const f=await operationFixture(),tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("DELETE FROM public.planning_resource_calendars WHERE machine_id=$1",[f.machine]);
      await tx.query("UPDATE public.programmation_calendars SET active=(id=$1)",[f.calendar]);
      let resource=(await readCentralResources(tx,from,to)).find(r=>r.id==="machine:"+f.machine)!;
      expect(resource.availability[0].start).toBe(from);
      await tx.query("UPDATE public.programmation_calendars SET active=false WHERE id=$1",[f.calendar]);
      resource=(await readCentralResources(tx,from,to)).find(r=>r.id==="machine:"+f.machine)!;
      expect(resource.availability).toEqual([]);
    } finally {await tx.query("ROLLBACK");tx.release();}
  });
  it("un changement de profil sans effet sur les droits conserve la proposition",async()=>{
    const f=await fixture(),s=await createCentralSimulation(await intent(f.task),audit(),randomUUID());
    await pool.query("UPDATE public.users SET username=username||'-renamed' WHERE id=$1",[f.user]);
    await expect(applyCentralSimulation(s.id,s.revision,audit(),randomUUID())).resolves.toBeDefined();
  });
  it("l'arrêt d'activation côté serveur interdit toute application",async()=>{
    const f=await fixture(),s=await createCentralSimulation(await intent(f.task),audit(),randomUUID());
    await pool.query("UPDATE public.planning_central_settings SET activation='READ'");
    try {await expect(applyCentralSimulation(s.id,s.revision,audit(),randomUUID())).rejects.toMatchObject({code:"PLANNING_ACTIVATION_REQUIRED"});}
    finally {await pool.query("UPDATE public.planning_central_settings SET activation='COMMIT'");}
  });
});
