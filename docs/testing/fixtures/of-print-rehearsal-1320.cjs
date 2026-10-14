const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const pool=require('../../../src/config/database').default;
const {requestOfDocumentPrint}=require('../../../src/module/production/services/of-document-print.service');
const {archiveOfDocument,readArchivedOfDocument}=require('../../../src/module/production/services/of-document-archive');
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
   INSERT INTO public.ordres_fabrication(id,numero,piece_technique_id,quantite_lancee,statut,created_by)
    VALUES(1320001,'OF-QUAL-1320','${uuid(1)}',40,'BROUILLON',7);
   INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,statut,snapshot,snapshot_sha256)
    VALUES('${uuid(2)}',1320001,0,'R00','ACTIVE','{}',repeat('a',64));`);
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
 await tx.query('COMMIT');tx.release();
 // All actual print commands run with application privileges, not owner privileges.
 const originalConnect=pool.connect.bind(pool);
 pool.connect=async()=>{const client=await originalConnect();await client.query('SET ROLE cerp_app');return client;};
 const audit={user_id:7,ip:null,user_agent:'isolated-qualification',device_type:null,os:null,browser:null,path:'/qualification',page_key:null,client_session_id:null};
 const print=key=>requestOfDocumentPrint(1320001,uuid(3),key,7,audit);
 const first=await print('qual1320-original');assert.equal(first.intent.official_ordinal,1);assert.equal(first.intent.copy_mark,null);
 assert(first.pdf.equals(bytes));
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
 assert.equal((await db.query('SELECT reprint_count FROM public.of_documents WHERE id=$1',[uuid(3)])).rows[0].reprint_count,99);
 await assert.rejects(db.query('UPDATE public.of_document_print_intents SET official_ordinal=9'),error=>['42501','55000'].includes(error.code));
 const privileges=(await db.query(`SELECT has_table_privilege('cerp_app','public.of_document_print_intents','INSERT') AS insert,
   has_table_privilege('cerp_app','public.of_document_print_intents','UPDATE') AS update,
   has_table_privilege('cerp_app','public.of_document_print_intents','DELETE') AS delete`)).rows[0];
 assert.deepEqual(privileges,{insert:true,update:false,delete:false});db.release();
 console.log('OF_PRINT1320_COMMANDS_PASS '+JSON.stringify({actualPrintCommands:3,concurrentDuplicateCopies:2,replayedRequests:2,
   officialOrdinals:[1,2,3],variants:1,originalBytesUnchanged:true,applicationRole:true,initialOfficialIssuance:'SIMULATED_FIXTURE',physicalPrint:false}));
}
main().catch(error=>{console.error(error.code||error.name,error.message);process.exitCode=1;}).finally(()=>pool.end());
