const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const root=process.env.SUPPLIER1270_COMPILED_ROOT;
assert(root,'Explicit isolated compiled fixture required');
const pool=require(path.join(root,'config/database.js')).default;
const repo=require(path.join(root,'module/commande-fournisseur/repository/commande-fournisseur.repository.js'));
const archives=require(path.join(root,'shared/authoritative-documents/authoritative-document.repository.js'));
const service=require(path.join(root,'shared/authoritative-documents/authoritative-document.service.js'));
const {createAuthoritativePdfProducerRegistry}=require(path.join(root,'shared/authoritative-documents/authoritative-document.worker.js'));
const id='8dd33def-925b-4bcd-9730-c4993371744e';
const audit={user_id:1,role:'Administrateur Systeme et Reseau',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
let checks=0;
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function token(){return(await pool.query('SELECT updated_at::text AS revision FROM public.commande_fournisseur WHERE id=$1',[id])).rows[0].revision;}
async function state(){return(await pool.query(`SELECT version_document,updated_at::text,
 (SELECT count(*)::int FROM public.commande_fournisseur_document WHERE commande_id=$1::uuid) AS docs,
 (SELECT count(*)::int FROM public.authoritative_pdf_archives WHERE entity_id=$1::text) AS archives,
 (SELECT count(*)::int FROM public.authoritative_pdf_archive_outbox o JOIN public.authoritative_pdf_archives a ON a.id=o.archive_id WHERE a.entity_id=$1::text) AS jobs
 FROM public.commande_fournisseur WHERE id=$1::uuid`,[id])).rows[0];}
async function rejectsCode(fn,code){await assert.rejects(fn,e=>e.code===code);}
async function materialize(archive,filename){
 const lease=(await pool.query(`UPDATE public.authoritative_pdf_archive_outbox SET status='PROCESSING',locked_at=now(),locked_by='fixture1270',claim_token=gen_random_uuid(),attempt_count=attempt_count+1 WHERE archive_id=$1 AND status='PENDING' RETURNING id::text,claim_token::text`,[archive.id])).rows[0];assert(lease);
 await service.runClaimedAuthoritativePdfArchive({outboxId:lease.id,claimToken:lease.claim_token,archive},createAuthoritativePdfProducerRegistry());
 const args={entityType:'commande-fournisseur',entityId:id,documentKind:'SUPPLIER_PURCHASE_ORDER',archiveId:archive.id,actorUserId:1,eventType:'AUTHORITATIVE_PDF_DOWNLOADED'};
 const first=await service.readOfficialPdfBytes(args),second=await service.readOfficialPdfBytes(args);
 assert.equal(first.sha256,second.sha256);assert.deepEqual(first.bytes,second.bytes);assert(first.bytes.subarray(0,5).equals(Buffer.from('%PDF-')));
 await fs.writeFile(path.join(process.env.SUPPLIER1270_OUTPUT_ROOT,filename),first.bytes);
 return {archiveId:archive.id,edition:archive.documentVersion,sha256:first.sha256,bytes:first.bytes.length};
}
async function main(){
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'supplier_document_1270');
 const historical=(await pool.query(`SELECT id::text,source_snapshot,snapshot_sha256,pdf_sha256,ged_version_id::text FROM public.authoritative_pdf_archives WHERE entity_id=$1 ORDER BY document_version`,[id])).rows;
 assert.equal(historical.length,1);assert.equal(historical[0].source_snapshot.status,'BROUILLON');
 await check('historical creation draft retained separately',async()=>assert.equal(historical[0].source_snapshot.code,'BCF-2026-1304'));
 await check('missing reason refuses reissue without writes',async()=>{const before=await state(),revision=await token();await rejectsCode(()=>repo.repoQueueSupplierPoOfficialDocument(id,'fixture1270-no-reason',audit,{source_revision:revision}),'OFFICIAL_DOCUMENT_REISSUE_REASON_REQUIRED');assert.deepEqual(await state(),before);});
 await check('stale revision refuses reissue without writes',async()=>{const before=await state();await rejectsCode(()=>repo.repoQueueSupplierPoOfficialDocument(id,'fixture1270-stale',audit,{source_revision:'stale',reissue_reason:'Fixture correction'}),'OFFICIAL_DOCUMENT_SOURCE_REVISION_CONFLICT');assert.deepEqual(await state(),before);});
 // Modify only the disposable restored fixture: immutable commercial terms must win.
 await pool.query('UPDATE public.commande_fournisseur_ligne SET prix_unitaire_ht=99 WHERE commande_id=$1',[id]);
 let corrected;
 await check('legacy correction preserves frozen 18+2 quantities, six euro price and totals',async()=>{
  corrected=await repo.repoQueueSupplierPoOfficialDocument(id,'fixture1270-legacy-correction',audit,{source_revision:await token(),reissue_reason:'Corrective issuance of approved historical freeze'});
  const s=corrected.sourceSnapshot;assert.equal(s.status,'APPROUVEE');assert.deepEqual(s.lines.map(l=>Number(l.quantity)),[18,2]);assert(s.lines.every(l=>Number(l.unit_price_ht)===6));assert.equal(Number(s.totals.total_ht),160);assert.equal(Number(s.totals.total_ttc),192);assert.equal(corrected.documentVersion,2);assert.equal(s.general_terms,null);assert(s.corrective_issuance);assert.equal(s.issued_at.slice(0,10),new Date().toISOString().slice(0,10));
 });
 await check('accepted reissue key replays despite changed revision',async()=>{const replay=await repo.repoQueueSupplierPoOfficialDocument(id,'fixture1270-legacy-correction',audit,{source_revision:'stale'});assert.equal(replay.id,corrected.id);assert.equal((await state()).archives,2);});
 let correctedPdf;
 await check('corrective PDF archived in private GED and exact bytes read twice',async()=>{correctedPdf=await materialize(corrected,'supplier1270-corrected-legacy.pdf');});
 await pool.query("UPDATE public.commande_fournisseur SET statut='APPROUVEE' WHERE id=$1",[id]);
 await pool.query('UPDATE public.commande_fournisseur_ligne SET prix_unitaire_ht=6 WHERE commande_id=$1',[id]);
 const failureBefore=await state();
 await pool.query(`CREATE FUNCTION public.fixture1270_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM public.authoritative_pdf_archives WHERE id=NEW.archive_id AND entity_id='${id}') THEN RAISE EXCEPTION 'fixture1270-outbox-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture1270_fail_outbox BEFORE INSERT ON public.authoritative_pdf_archive_outbox FOR EACH ROW EXECUTE FUNCTION public.fixture1270_fail_outbox()`);
 await check('outbox failure rolls back header, legacy freeze and archive atomically',async()=>{await assert.rejects(()=>repo.repoGenerateDocumentVersion(id,'Fixture atomicity',failureBefore.updated_at,audit),/fixture1270-outbox-failure/);assert.deepEqual(await state(),failureBefore);});
 await pool.query('DROP TRIGGER fixture1270_fail_outbox ON public.authoritative_pdf_archive_outbox; DROP FUNCTION public.fixture1270_fail_outbox()');
 const freezeToken=await token();let frozen;
 await check('normal approved freeze creates legacy document, PDF intent and outbox together',async()=>{
  frozen=await repo.repoGenerateDocumentVersion(id,'Fixture approved freeze',freezeToken,audit);assert.equal(frozen.version,2);
  const current=await state();assert.equal(current.docs,2);assert.equal(current.archives,3);assert.equal(current.jobs,3);
 });
 const fresh=await archives.repoFindAuthoritativePdfByIdempotency(pool,'commande-fournisseur:'+id+':freeze:'+frozen.id);assert(fresh);
 await check('freeze PDF uses approved state and same frozen revision',async()=>{assert.equal(fresh.sourceSnapshot.status,'APPROUVEE');assert.equal(fresh.sourceSnapshot.frozen_document.id,frozen.id);assert.equal(fresh.documentVersion,3);assert.equal(fresh.sourceRevision,await token());assert(fresh.sourceSnapshot.lines.every(l=>Number(l.unit_price_ht)===6));});
 await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE' WHERE id=$1",[id]);
 await check('concurrent network retries after send return same freeze and no extra edition',async()=>{const before=await state();const repeated=await Promise.all([1,2].map(()=>repo.repoGenerateDocumentVersion(id,'Fixture approved freeze',freezeToken,audit)));assert(repeated.every(d=>d.id===frozen.id));assert.deepEqual(await state(),before);});
 await check('new freeze on sent order remains forbidden',async()=>{await rejectsCode(()=>repo.repoGenerateDocumentVersion(id,'Another freeze',undefined,audit),'DOCUMENT_STATUT_INVALIDE');});
 let approvedPdf;
 await check('approved freeze PDF archived and exact bytes read twice',async()=>{approvedPdf=await materialize(fresh,'supplier1270-approved-freeze.pdf');});
 await pool.query('UPDATE public.commande_fournisseur_ligne SET prix_unitaire_ht=123 WHERE commande_id=$1',[id]);
 await check('later explicit reissue uses full frozen snapshot, never current prices',async()=>{const next=await repo.repoQueueSupplierPoOfficialDocument(id,'fixture1270-new-freeze-reissue',audit,{source_revision:await token(),reissue_reason:'Fixture explicit reissue'});assert.equal(next.documentVersion,4);assert(next.sourceSnapshot.lines.every(l=>Number(l.unit_price_ht)===6));assert.equal(next.sourceSnapshot.frozen_document.id,frozen.id);assert.equal(next.sourceRevision,fresh.sourceRevision);});
 await check('historic draft source, hash and GED version remain unchanged',async()=>{assert.deepEqual((await pool.query('SELECT id::text,source_snapshot,snapshot_sha256,pdf_sha256,ged_version_id::text FROM public.authoritative_pdf_archives WHERE id=$1',[historical[0].id])).rows[0],historical[0]);});
 console.log(JSON.stringify({status:'PASSED',checks,database:'supplier_document_1270',pdfs:[correctedPdf,approvedPdf],liveDatabasesChanged:false}));
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;}).finally(()=>pool.end());
