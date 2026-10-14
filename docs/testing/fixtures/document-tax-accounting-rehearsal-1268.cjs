const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {allocateDocumentTaxBreakdown}=require('../../../dist/module/facturation/domain/document-tax-breakdown');
const accounting=require('../../../dist/module/accounting-export/accounting-export.repository');
const {accountingMappingConfigSchema}=require('../../../dist/module/accounting-export/accounting-export.validators');
const {readFinanceDraftInput}=require('../../../dist/module/facturation/services/finance-draft-input');
const {repoLoadElectronicInvoiceSource}=require('../../../dist/module/facturation/electronic-invoicing/electronic-invoice.repository');

/** The fiscal row is an explicit storage fixture. Exercise actual export commands. */
module.exports=async function qualifyTaxAccounting(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const invoiceId=1268501,actor={userId:7,requestId:'qualification-tax-accounting',path:'/qualification/accounting-exports'};
 const model=allocateDocumentTaxBreakdown({lines:[{ratePercent:'20',net:'100.00',tax:'20.00'},{ratePercent:'5.5',net:'100.00',tax:'5.50'}],
  totalExTax:'190.00',totalTax:'24.23',totalInclTax:'214.23'});
 const seed=await pool.connect();
 try{
  await seed.query('BEGIN');
  await seed.query("UPDATE public.clients SET compte_tiers='411QUAL1268' WHERE client_id=$1",[args.billedClientId]);
  await seed.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission,remise_globale)
    VALUES($1,'QUAL-SYNTHETIC-MULTI-VAT',$2,'DRAFT',190,24.23,214.23,'EUR','2026-08-18',5)`,[invoiceId,args.billedClientId]);
  for(const [id,order,rate,tax,gross]of[[1268501,1,20,20,120],[1268502,2,5.5,5.5,105.5]]){
   await seed.query(`INSERT INTO public.facture_ligne(id,facture_id,ordre,designation,quantite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
    VALUES($1,$2,$3,'Ligne fiscale synthétique isolée',1,100,0,$4,100,$5,$6)`,[id,invoiceId,order,rate,tax,gross]);
  }
  const draft=await readFinanceDraftInput(seed,'FACTURE',invoiceId);
  assert.equal(draft.totals.subtotalExTax,'200.00');assert.equal(draft.totals.globalDiscountAmount,'10.00');
  assert.deepEqual(draft.taxBreakdown,model);
  await seed.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
    VALUES(1268511,'QUAL-DRAFT-EXACT-PRICE',$1,'DRAFT',75,15,90,'USD','2026-08-19')`,[args.billedClientId]);
  await seed.query(`INSERT INTO public.facture_ligne(id,facture_id,ordre,designation,quantite,unite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
    VALUES(1268511,1268511,1,'Barre de qualification',3000,'mm',0.025,0,20,75,15,90)`);
  for(const [date,amount]of[['2026-09-18',30],['2026-10-18',60]])await seed.query(`INSERT INTO public.facture_echeance(facture_id,due_date,label,amount_due,status,created_by)
    VALUES(1268511,$1,'Échéance de qualification',$2,'OPEN',7)`,[date,amount]);
  const precise=await readFinanceDraftInput(seed,'FACTURE',1268511);
  assert.equal(precise.lines[0].unitPriceExTax,'0.0250');assert.equal(precise.lines[0].quantity,'3000.000');assert.equal(precise.currency,'USD');
  assert.equal(precise.dueDates.length,2);assert.deepEqual(precise.dueDates.map(due=>due.amount),['30.00','60.00']);
  await seed.query(`INSERT INTO public.avoir(id,numero,client_id,facture_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
    VALUES(1268511,'QUAL-DRAFT-EXACT-CREDIT',$1,1268511,'DRAFT',75.56,15.21,90.77,'USD','2026-08-18')`,[args.billedClientId]);
  await seed.query(`INSERT INTO public.avoir_ligne(id,avoir_id,ordre,designation,quantite,unite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
    VALUES(1268511,1268511,1,'Crédit de qualification',3000,'mm',0.0255,1.2345,20.125,75.56,15.21,90.77)`);
  const preciseCredit=await readFinanceDraftInput(seed,'AVOIR',1268511);
  assert.equal(preciseCredit.lines[0].unitPriceExTax,'0.0255');assert.equal(preciseCredit.lines[0].discountPercent,'1.2345');
  assert.equal(preciseCredit.lines[0].taxRatePercent,'20.1250');assert.equal(preciseCredit.totals.totalInclTax,'90.77');
  const retainedLine={source_line_id:'qualification-original',designation:'Barre de qualification',quantity:'3000.000',unit:'mm',
    unit_price_ex_tax:'0.0250',discount_percent:'0.0000',tax_rate_percent:'20.0000',total_ex_tax:'75.00',total_incl_tax:'90.00'};
  // Emulate an old invoice whose stored line price rounded, while its fiscal
  // snapshot and totals retained the original price. Never change a live invoice.
  await seed.query('UPDATE public.facture_ligne SET prix_unitaire_ht=0.03 WHERE id=1268511');
  const issuer={siren:'123456789',vat_number:'FR00123456789',company_name:'Émetteur fictif isolé',address_line_1:'1 rue Exemple',postal_code:'69001',city:'Lyon',country:'FR'};
  const customer={siret:'98765432100011',company_name:'Client fictif isolé',billing_address:{street:'2 rue Exemple',postal_code:'69001',city:'Lyon',country:'FR'}};
  const regulatory={specVersion:'DGFiP-FE-V3.2-2026-04-30',billingFrameCatalogVersion:'AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30',
    billingFrameCode:'B1',operationCategory:'GOODS',transactionScope:'FR_PRIVATE_B2B',buyerSiren:'987654321',deliveryAddress:null,
    sellerElectronicAddress:{scheme:'0225',value:'123456789',directoryEntryId:'fixture-seller',verifiedAt:'2026-08-18T10:00:00Z'},
    buyerElectronicAddress:{scheme:'0225',value:'987654321',directoryEntryId:'fixture-buyer',verifiedAt:'2026-08-18T10:00:00Z'}};
  await seed.query(`INSERT INTO public.einvoice_billing_frame_catalog(catalog_version,code,operation_category,label_fr,source_reference,effective_from)
    VALUES($1,'B1','GOODS','Facture de biens','Qualification isolée BT-23','2026-04-30') ON CONFLICT DO NOTHING`,[regulatory.billingFrameCatalogVersion]);
  await seed.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-LEGACY-NO-LEGAL-SEQUENCE',issued_at=now(),issued_by=7,
    billing_frame_catalog_version='AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30',billing_frame_code='B1',operation_category='GOODS',transaction_scope='FR_PRIVATE_B2B',
    immutable_snapshot=$1::jsonb,issuer_snapshot=$2::jsonb,client_snapshot=$3::jsonb,regulatory_snapshot=$4::jsonb,document_checksum_sha256=repeat('e',64),row_version=2 WHERE id=1268511`,
    [JSON.stringify({synthetic_fiscal_storage_fixture:true,lines:[retainedLine]}),JSON.stringify(issuer),JSON.stringify(customer),JSON.stringify(regulatory)]);
  const issued=await repoLoadElectronicInvoiceSource(1268511,seed);
  assert.equal(issued.lines[0].unit_price_ex_tax,'0.0250');assert.equal(issued.totals.gross,'90.00');
  await seed.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-TAX-NO-LEGAL-SEQUENCE',issued_at=now(),issued_by=7,
    immutable_snapshot=$2::jsonb,document_checksum_sha256=repeat('d',64),row_version=2 WHERE id=$1`,[invoiceId,JSON.stringify({synthetic_fiscal_storage_fixture:true,tax_breakdown:model})]);
  await seed.query('COMMIT');
 }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
 await assert.rejects(()=>readFinanceDraftInput(pool,'FACTURE',invoiceId),error=>error.code==='FACTURE_DOCUMENT_IMMUTABLE');
 const config={delimiter:';',sales_journal:'VE',credit_journal:'AV',bank_journal_by_mode:{},bank_account_by_mode:{},default_bank_journal:null,default_bank_account:null,
  sales_account_by_tax:{'20':'70120','5.5':'70155'},vat_output_account_by_tax:{'20':'4457120','5.5':'4457155'},default_axes:{}};
 const mapping=await accounting.repoCreateAccountingMapping({actor,idempotencyKey:'qual1268-tax-mapping',input:{version_code:'QUAL1268-TAX',
  adapter_code:'GENERIC_DELIMITED_V1',effective_from:'2026-08-18',effective_to:'2026-08-18',activate:true,config:accountingMappingConfigSchema.parse(config)}});
 const input={mapping_version_id:mapping.id,period_from:'2026-08-18',period_to:'2026-08-18',source_types:['INVOICE']};
 const preview=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:'qual1268-tax-preview',input});
 assert.equal(preview.source_count,1);assert.equal(preview.line_count,5);assert.deepEqual(preview.findings,[]);
 assert.deepEqual(preview.currency_totals,[{currency:'EUR',debit:'214.23',credit:'214.23',balanced:true}]);
 const snapshot=(await pool.query('SELECT source_snapshot FROM public.accounting_export_batch_sources WHERE batch_id=$1',[preview.id])).rows[0].source_snapshot;
 assert.deepEqual(snapshot.tax_breakdown,[{tax_rate:'5.5000',total_ex_tax:'95.00',tax_amount:'5.23'},{tax_rate:'20.0000',total_ex_tax:'95.00',tax_amount:'19.00'}]);
 assert.equal(snapshot.tax_snapshot.allowance_ex_tax,'10.00');
 const validated=await accounting.repoValidateAccountingBatch({batchId:preview.id,body:{expected_version:preview.row_version},actor,idempotencyKey:'qual1268-tax-validate'});
 const generateArgs={batchId:preview.id,body:{expected_version:validated.row_version},actor,idempotencyKey:'qual1268-tax-generate'};
 const generated=await accounting.repoGenerateAccountingBatch(generateArgs),replay=await accounting.repoGenerateAccountingBatch(generateArgs);
 assert.equal(generated.status,'GENERATED');assert.equal(replay.idempotent_replay,true);assert.equal(generated.id,replay.id);
 const artifact=await accounting.repoDownloadAccountingArtifact(generated.id);
 assert.equal(crypto.createHash('sha256').update(artifact.content).digest('hex'),artifact.sha256);
 const csv=artifact.content.toString('utf8');assert.ok(csv.includes('JournalCode;EcritureDate;PieceRef'));
 assert.ok(csv.includes('70120')&&csv.includes('70155'));assert.ok(csv.includes('95.00')&&csv.includes('5.23')&&csv.includes('19.00'));
 const claims=(await pool.query('SELECT count(*)::int AS n FROM public.accounting_export_source_claims WHERE batch_id=$1',[generated.id])).rows[0].n;
 assert.equal(claims,1);
 const duplicate=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:'qual1268-tax-duplicate-preview',input});
 assert.ok(duplicate.findings.some(finding=>finding.code==='ACCOUNTING_SOURCE_ALREADY_EXPORTED'));
 console.log(JSON.stringify({marker:'PROFORMA1268_DOCUMENT_TAX_ACCOUNTING_PASS',actualExportCommands:true,globalAllowance:'10.00',
  vatBases:['95.00','95.00'],vatAmounts:['5.23','19.00'],balancedGross:'214.23',artifactHashVerified:true,
  idempotentReplay:true,duplicateExportBlocked:true,claims:1,fiscalInvoice:'synthetic storage fixture',
  exactDraftReader:true,unitPriceRetained:'0.0250',multipleInstallmentsRetained:true,issuedDraftRegenerationRefused:true,
  creditPriceAndPercentagesRetained:true,legacyIssuedSnapshotPriceRetained:true,
  actualFiscalIssuance:false,externalAccountingImport:false,uiRecipe:false,businessRecipePassed:false}));
};
