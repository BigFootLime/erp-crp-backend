const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const pool=require('../../../src/config/database').default;
const {requestOfDocumentPrint}=require('../../../src/module/production/services/of-document-print.service');
const {archiveOfDocument,readArchivedOfDocument}=require('../../../src/module/production/services/of-document-archive');
const {composeWorkshopPackPdf}=require('../../../src/module/production/services/workshop-pack-pdf');
const {printWorkshopFolder,previewWorkshopFolder}=require('../../../src/module/production/services/workshop-folder.service');
const {storageKeyForSha256}=require('../../../src/module/ged/services/ged-vault.service');
const {readWorkshopAnnexSources}=require('../../../src/module/production/repository/workshop-annex.repository');
const fs=require('node:fs/promises'),path=require('node:path');
const {claimWorkshopDispatchJob,printWorkshopDispatchJob,acknowledgeWorkshopDispatchJob}=require('../../../src/module/production/services/workshop-dispatch.service');
const {dossierSourceHash}=require('../../../src/module/production/domain/of-dossier');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const uuid=n=>`13200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function main(){
 const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 assert(/^cerp_qualify_1320_\d{14}$/.test(database));
 await pool.query(`INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
   INSERT INTO public.planning_forecast_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
   INSERT INTO public.planning_learning_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
   INSERT INTO public.users(id,username,password,name,surname,email,role)
    VALUES(7,'QUAL1320','ISOLATED_LOGIN_DISABLED','Qualification','Print','qualification@example.invalid','Directeur');
   INSERT INTO public.ged_document_classes(class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes)
    VALUES('OF_DOSSIER','PRODUCTION','Dossier atelier','GENERATED',ARRAY['application/pdf'],ARRAY['pdf'],52428800);
   INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,famille_id,name_piece,code_piece,designation,created_by)
    VALUES('${uuid(1)}','${uuid(1)}',1,NULL,'Pièce fictive impression','QUAL-PRINT-1320','Pièce fictive impression',7);
   INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,date_revision,version_interne,code_metier,code_metier_normalise)
    VALUES('${uuid(1)}','${uuid(1)}','A','QUAL-PRINT-1320','BROUILLON',false,now(),1,'QUAL-PRINT-A','QUALPRINTA');
   INSERT INTO public.ordres_fabrication(id,numero,piece_technique_id,quantite_lancee,statut,created_by,piece_technique_version_id,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_preparation)
    VALUES(1320001,'OF-QUAL-1320','${uuid(1)}',40,'BROUILLON',7,'${uuid(1)}','{"operations":[{"phase":10,"type_operation":"SOUS_TRAITANCE"},{"phase":20,"type_operation":"USINAGE"}]}',repeat('a',64),now(),'{"self_inspection_sheet_id":"13200000-0000-4000-8000-000000000007","execution_quality":{"quality_plan":{"id":"13200000-0000-4000-8000-000000000004"}}}');
   INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by)
    SELECT id,piece_technique_version_id,technical_snapshot,technical_snapshot_sha256,7 FROM public.ordres_fabrication WHERE id=1320001;
   INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,statut,snapshot,snapshot_sha256)
    VALUES('${uuid(2)}',1320001,0,'R00','ACTIVE','{"version":{"id":"13200000-0000-4000-8000-000000000001"},"piece":{"code":"QUAL"},"operations":[{"phase":10,"type_operation":"SOUS_TRAITANCE"},{"phase":20,"type_operation":"USINAGE"}],"documents":[{"role":"PLAN_CLIENT","id":"13200000-0000-4000-8000-000000000050","version_id":"13200000-0000-4000-8000-000000000051","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]}',repeat('a',64));
   INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation) VALUES('${uuid(61)}',1320001,'${uuid(2)}',10,'External fixture'),('${uuid(62)}',1320001,'${uuid(2)}',20,'Machine fixture');`);
 const pdf=await PDFDocument.create();const page=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.setCreationDate(new Date('2026-10-14T08:00:00Z'));pdf.setModificationDate(new Date('2026-10-14T08:00:00Z'));
 page.drawText('OF QUALIFICATION ORIGINAL',{font,x:40,y:750});const bytes=Buffer.from(await pdf.save());
 const payload={ofNumero:'OF-QUAL-1320',revisionCode:'R00',pieceReference:'QUAL-PRINT-1320',documentStatut:'OFFICIEL',watermark:null};
 const tx=await pool.connect();await tx.query('BEGIN');
 const archive=await archiveOfDocument(tx,{ofNumero:payload.ofNumero,revisionCode:'R00',pieceReference:payload.pieceReference,
   pdf:bytes,pdfSha256:hash(bytes),existingGedDocumentId:null,actorUserId:7,changeReason:'Synthetic original issuance fixture'});
 assert(archive.archived);
 await tx.query(`INSERT INTO public.of_documents(id,of_id,revision_id,payload,payload_sha256,pdf_sha256,pdf_byte_size,
   generated_at,generated_by,statut,ged_document_id,ged_version_id,reprint_count)
   VALUES($1,1320001,$2,$3,$4,$5,$6,'2026-10-14T08:00:00Z',7,'OFFICIEL',$7,$8,99)`,
   [uuid(3),uuid(2),JSON.stringify(payload),hash(Buffer.from(JSON.stringify(payload))),hash(bytes),bytes.length,archive.gedDocumentId,archive.gedVersionId]);

 const parts=[{kind:'OF',name:'OF qualification',bytes,sha256:hash(bytes)},
  {kind:'PLAN_CLIENT',name:'Plan fictif',bytes,sha256:hash(bytes)},
  {kind:'AUTOCONTROLE',name:'Autocontrôle fictif',bytes,sha256:hash(bytes)}];
 const manifest=parts.map(({kind,name,sha256})=>({kind,name,sha256}));
 await tx.query(`INSERT INTO public.of_workshop_folders(id,of_id,document_id,revision_id,document_status,source_fingerprint,
  source_manifest,created_by,idempotency_key) VALUES($1,1320001,$2,$3,'OFFICIEL',$4,$5,7,'fixture-folder1320')`,
  [uuid(10),uuid(3),uuid(2),hash(Buffer.from(JSON.stringify(manifest))),JSON.stringify(manifest)]);
 const packets={};
 for(const mark of ['ORIGINAL','DUPLICATA','OBSOLETE']) {
  const packet=await composeWorkshopPackPdf({number:payload.ofNumero,generatedAt:'2026-10-14T08:00:00Z',parts,ofMark:mark==='ORIGINAL'?null:mark});
  const saved=await archiveOfDocument(tx,{ofNumero:payload.ofNumero+' DOSSIER '+mark,revisionCode:'R00',pieceReference:payload.pieceReference,
    pdf:packet.bytes,pdfSha256:packet.sha256,existingGedDocumentId:null,actorUserId:7,changeReason:'Synthetic pinned packet fixture'});
  assert(saved.archived);assert.equal(packet.pages,3);packets[mark]=packet;
  await tx.query(`INSERT INTO public.of_workshop_folder_copies(folder_id,copy_mark,pdf_sha256,pdf_byte_size,page_count,page_manifest,
   ged_document_id,ged_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
   [uuid(10),mark,packet.sha256,packet.bytes.length,packet.pages,JSON.stringify(packet.manifest),saved.gedDocumentId,saved.gedVersionId]);
 }
 await tx.query(`INSERT INTO public.of_workshop_folder_preparations(idempotency_key,folder_id,actor_id) VALUES('fixture-prepare1320',$1,7)`,[uuid(10)]);
 await tx.query('COMMIT');tx.release();


 // Initial definition/blank sheet and folder are explicit synthetic fixture states.
 await pool.query(`INSERT INTO public.postes(id,code,label,created_by) VALUES($1,'QUAL-1320','Poste qualification',7)`,[uuid(60)]);
 await pool.query(`UPDATE public.ordres_fabrication SET technical_readiness='VALIDATED' WHERE id=1320001`);
 const sourceHash=dossierSourceHash({technicalHash:'a'.repeat(64),revision:uuid(1),quantity:40,
   operations:[{id:uuid(61),phase:10,label:'External fixture',setup:0,unit:0,base:1,coefficient:1},
    {id:uuid(62),phase:20,label:'Machine fixture',setup:0,unit:0,base:1,coefficient:1}]});
 await pool.query(`INSERT INTO public.of_dossier_validations(of_id,source_hash,planning_revision,evidence,decided_by) VALUES(1320001,$1,1,'{}',7)`,[sourceHash]);
 // All actual print commands run with application privileges, not owner privileges.
 const originalConnect=pool.connect.bind(pool);
 pool.connect=(callback)=>{
 if(typeof callback==='function') {
  originalConnect((error,client,release)=>{
   if(error)return callback(error);
   client.query('SET ROLE cerp_app').then(()=>callback(null,client,release),failure=>{release(failure);callback(failure);});
  });return;
 }
 return originalConnect().then(async client=>{await client.query('SET ROLE cerp_app');return client;});
};
 const sourceReader=await pool.connect();
 const annex=await readWorkshopAnnexSources(sourceReader,{of_id:1320001,revision_id:uuid(2),payload:{...payload,quantiteLancee:40,
  technicalEvidence:{source:{hash:'a'.repeat(64),technicalVersionId:uuid(1)}}}});
 assert.equal(annex.plans.length,0);assert.equal(annex.missingPlans.length,1);assert.equal(annex.inspection,null);sourceReader.release();
 const audit={user_id:7,ip:null,user_agent:'isolated-qualification',device_type:null,os:null,browser:null,path:'/qualification',page_key:null,client_session_id:null};
 const print=key=>printWorkshopFolder(1320001,uuid(10),key,7,audit);
 // Only this disposable fixture's blob is moved. A missing packet must not burn the first ordinal.
 const packetPath=path.resolve(process.env.CERP_GED_VAULT_ROOT,storageKeyForSha256(packets.ORIGINAL.sha256));
 assert(packetPath.startsWith(path.resolve(process.env.CERP_GED_VAULT_ROOT)+path.sep));
 await fs.rename(packetPath,packetPath+'.qualification-held');
 await assert.rejects(print('qual1320-original'));
 const check=await pool.connect();assert.equal((await check.query('SELECT count(*)::int AS n FROM public.of_document_print_intents')).rows[0].n,0);check.release();
 await fs.rename(packetPath+'.qualification-held',packetPath);
 assert((await previewWorkshopFolder(1320001,uuid(10))).pdf.equals(packets.ORIGINAL.bytes));
 await assert.rejects(printWorkshopFolder(1320002,uuid(10),'wrong-of',7,audit),error=>error.code==='WORKSHOP_FOLDER_NOT_FOUND');
 const first=await print('qual1320-original');assert.equal(first.intent.official_ordinal,1);assert.equal(first.intent.copy_mark,null);
 assert(first.pdf.equals(packets.ORIGINAL.bytes));
 const copies=await Promise.all([print('qual1320-copy-a'),print('qual1320-copy-b')]);
 assert.deepEqual(copies.map(x=>x.intent.official_ordinal).sort(),[2,3]);assert(copies.every(x=>x.intent.copy_mark==='DUPLICATA'));
 assert(copies[0].pdf.equals(copies[1].pdf));assert(!copies[0].pdf.equals(bytes));
 const replays=await Promise.all([print('qual1320-copy-a'),print('qual1320-copy-a')]);
 assert(replays.every(x=>x.replayed && x.intent.official_ordinal===copies[0].intent.official_ordinal && x.pdf.equals(copies[0].pdf)));
 assert((await readArchivedOfDocument(hash(bytes))).equals(bytes));
 const db=await pool.connect();
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.of_document_print_intents')).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.of_document_print_variants')).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM public.erp_audit_logs WHERE action='OF_DOCUMENT_PRINT_INTENT'")).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.of_workshop_folder_prints')).rows[0].n,3);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM public.erp_audit_logs WHERE action='OF_WORKSHOP_FOLDER_PRINT'")).rows[0].n,3);
 await assert.rejects(db.query('UPDATE public.of_workshop_folder_copies SET page_count=1'),error=>['42501','55000'].includes(error.code));
 assert.equal((await db.query('SELECT reprint_count FROM public.of_documents WHERE id=$1',[uuid(3)])).rows[0].reprint_count,99);
 await assert.rejects(db.query('UPDATE public.of_document_print_intents SET official_ordinal=9'),error=>['42501','55000'].includes(error.code));
 const privileges=(await db.query(`SELECT has_table_privilege('cerp_app','public.of_document_print_intents','INSERT') AS insert,
   has_table_privilege('cerp_app','public.of_document_print_intents','UPDATE') AS update,
   has_table_privilege('cerp_app','public.of_document_print_intents','DELETE') AS delete`)).rows[0];
 assert.deepEqual(privileges,{insert:true,update:false,delete:false});db.release();

 const dispatch=await pool.connect();
 assert.equal((await dispatch.query('SELECT count(*)::int AS n FROM public.of_workshop_print_jobs')).rows[0].n,0);
 await dispatch.query('BEGIN');
 await dispatch.query("UPDATE public.planning_tasks SET committed_start='2026-11-01T08:00:00Z',committed_end='2026-11-01T09:00:00Z' WHERE operation_id=$1",[uuid(61)]);
 assert.equal((await dispatch.query('SELECT count(*)::int AS n FROM public.of_workshop_print_jobs')).rows[0].n,1);
 await dispatch.query('ROLLBACK');
 assert.equal((await dispatch.query('SELECT count(*)::int AS n FROM public.of_workshop_print_jobs')).rows[0].n,0);
 await dispatch.query(`INSERT INTO public.planning_events(id,of_id,of_operation_id,kind,status,priority,title,start_ts,end_ts,poste_id,created_by)
   VALUES($1,1320001,$2,'OF_OPERATION','PLANNED','NORMAL','Qualification','2026-11-01T08:00:00Z','2026-11-01T09:00:00Z',$3,7)`,[uuid(63),uuid(62),uuid(60)]);
 await dispatch.query("UPDATE public.planning_events SET start_ts='2026-11-01T10:00:00Z',end_ts='2026-11-01T11:00:00Z' WHERE id=$1",[uuid(63)]);
 await dispatch.query("UPDATE public.planning_tasks SET committed_start='2026-11-01T08:00:00Z',committed_end='2026-11-01T09:00:00Z' WHERE operation_id=$1",[uuid(61)]);
 const queued=(await dispatch.query('SELECT id::text,revision_rank,technical_sha256 FROM public.of_workshop_print_jobs')).rows;
 assert.equal(queued.length,1);assert.equal(queued[0].revision_rank,0);assert.equal(queued[0].technical_sha256,'a'.repeat(64));
 const jobId=queued[0].id,device=uuid(70),actor={userId:7,username:'QUAL1320',role:'Directeur'};
 dispatch.release();
 const claimed=await Promise.all([claimWorkshopDispatchJob(jobId,device,actor,audit),claimWorkshopDispatchJob(jobId,device,actor,audit)]);
 assert(claimed.every(j=>j.claimed_by===7&&j.device_id===device));
 await assert.rejects(claimWorkshopDispatchJob(jobId,uuid(71),actor,audit),e=>e.code==='WORKSHOP_JOB_CLAIMED');
 const prepKey='folder:'+hash(Buffer.from('prepare:1320001:7\0dispatch-prepare:'+jobId));
 // Replay preparation is deliberately seeded; this does not qualify normal preparation or physical printing.
 await pool.query('INSERT INTO public.of_workshop_folder_preparations(idempotency_key,folder_id,actor_id) VALUES($1,$2,7)',[prepKey,uuid(10)]);
 const sent=await printWorkshopDispatchJob(jobId,device,actor,audit),replay=await printWorkshopDispatchJob(jobId,device,actor,audit);
 assert.equal(sent.intent.id,replay.intent.id);assert.equal(sent.intent.official_ordinal,4);assert(sent.pdf.equals(replay.pdf));
 await assert.rejects(acknowledgeWorkshopDispatchJob(jobId,device,uuid(71),'SPOOLED',7,audit),e=>e.code==='WORKSHOP_JOB_COPY_MISMATCH');
 await acknowledgeWorkshopDispatchJob(jobId,device,sent.intent.id,'UNCERTAIN',7,audit);
 const receipt=await acknowledgeWorkshopDispatchJob(jobId,device,sent.intent.id,'SPOOLED',7,audit);
 assert.equal(receipt.state,'SPOOLED');assert((await acknowledgeWorkshopDispatchJob(jobId,device,sent.intent.id,'SPOOLED',7,audit)).replayed);
 await assert.rejects(printWorkshopDispatchJob(jobId,device,actor,audit),e=>e.code==='WORKSHOP_JOB_ALREADY_SPOOLED');
 const dispatchCheck=await pool.connect();
 const permits=(await dispatchCheck.query(`SELECT has_table_privilege('cerp_app','public.of_workshop_print_jobs','DELETE') AS delete,
  has_column_privilege('cerp_app','public.of_workshop_print_jobs','technical_sha256','UPDATE') AS identity_update`)).rows[0];
 assert.deepEqual(permits,{delete:false,identity_update:false});
 await assert.rejects(dispatchCheck.query("UPDATE public.of_workshop_print_jobs SET state='CLAIMED' WHERE id=$1",[jobId]),e=>e.code==='23514');
 assert.equal((await dispatchCheck.query('SELECT count(*)::int AS n FROM public.of_workshop_print_receipts')).rows[0].n,2);dispatchCheck.release();
 console.log('WORKSHOP_DISPATCH1320_COMMANDS_PASS '+JSON.stringify({planningRollback:true,eventAndExternalSources:true,
   jobCount:1,moveDoesNotRequeue:true,concurrentClaimReplay:true,otherDeviceRefused:true,acceptedCopyReplay:true,
   receipts:2,receiptReplay:true,terminalDowngradeRefused:true,applicationRole:true,initialPreparation:'EXPLICIT_SYNTHETIC_FIXTURE',physicalPrint:false}));
 console.log('WORKSHOP_FOLDER1320_COMMANDS_PASS '+JSON.stringify({actualPacketPrintCommands:3,missingPacketOrdinalRollback:true,packetPages:3,concurrentDuplicateCopies:2,replayedRequests:2,
   officialOrdinals:[1,2,3],variants:1,originalBytesUnchanged:true,applicationRole:true,initialOfficialIssuance:'SIMULATED_FIXTURE',physicalPrint:false}));
}
main().catch(error=>{console.error(error.code||error.name,error.message,error.table??'',error.constraint??'',error.stack);process.exitCode=1;}).finally(()=>pool.end());
