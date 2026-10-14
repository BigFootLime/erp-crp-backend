module.exports=function fixtureProformaDocument(count=1,companies=1,tools){
 const {computeExactDocumentTotals,formatDecimal,moneyToCents}=tools||require('../../../dist/module/facturation/domain/decimal-money');
 const party=(id,name)=>({client_id:id,client_code:'CLI-'+id,company_name:name,blocked:false,billing_address:{house_number:'12',street:'rue Exemple',postal_code:'69004',city:'Lyon',country:'France'}});
 const billed=Array.from({length:companies},(_,i)=>party(String(901+i),`Société exemple ${String.fromCharCode(65+i)}`));
 const physical=party('003','Client destinataire exemple');
 const affairs=Array.from({length:count},(_,i)=>{
  const source={allocation_id:23149+i,commande_id:'42720',commande_ligne_id:String(i+1),livraison_affaire_id:String(23149+i),
   client_id:physical.client_id,currency:'EUR',client_blocked:false,order_type:'FERME',affaire_status:'EN_COURS',
   delivery_address_id:null,contract_id:null,article_id:null,piece_technique_version_id:null,
   code_piece:i===0?'45 252 966 B':`EXEMPLE-${String(i+1).padStart(3,'0')}`,designation:i===0?'BOITIER T16E M2 SANS PIETAGE - SPEC 60 101 266-069 E':`Article exemple ${i+1} - fabrication selon plan`,
   quantity:'40.000',unit:'pièces',unit_price_ex_tax:'10.1250',discount_percent:'0.0000',global_discount_percent:'5.0000',tax_rate_percent:'20.0000',
   billing_shares:billed.map(p=>({id:'HIDDEN-SHARE',billed_client_id:p.client_id,quantity:companies===1?'40.000':'20.000'})),
   order_reference:'CMD-EXEMPLE-42720',customer_order_reference:'CF00042720 1',affaire_reference:String(23149+i)};
  return {allocation_id:source.allocation_id,source_revision:'f'.repeat(64),source_snapshot:source,billing_parts:billed.map(p=>{
   const qty=companies===1?'40.000':'20.000';
   const totals=computeExactDocumentTotals([{quantity:qty,unitPriceExTax:'10.1250',discountPercent:'0.0000',taxRatePercent:'20.0000'}],'5.0000');
   return {billed_client_id:p.client_id,quantity:qty,billed_client_snapshot:p,unit_price_ex_tax:'10.1250',discount_percent:'0.0000',global_discount_percent:'5.0000',tax_rate_percent:'20.0000',
    total_ex_tax:totals.totalExTax,tax_amount:totals.totalTax,total_incl_tax:totals.totalInclTax};
  })};
 });
 const totals=billed.map(p=>{
  const amounts=affairs.flatMap(a=>a.billing_parts.filter(part=>part.billed_client_id===p.client_id));
  const sum=key=>formatDecimal(amounts.reduce((n,a)=>n+moneyToCents(a[key]),0n),2);
  return {billed_client_id:p.client_id,company_name:p.company_name,total_ex_tax:sum('total_ex_tax'),tax_amount:sum('tax_amount'),total_incl_tax:sum('total_incl_tax')};
 });
 return {document_type:'PROFORMA',id:'12686000-0000-4000-8000-000000000001',reference:'PF-EXEMPLE-23149',issued_at:'2026-10-13T23:15:00Z',
  issuer_snapshot:{company_name:'Croix Rousse Précision - exemple',address_line_1:'12 rue Exemple',postal_code:'69004',city:'Lyon',country:'France'},
  preview:{version:1,client_id:physical.client_id,client_snapshot:physical,currency:'EUR',affairs,company_totals:totals,preview_hash:'e'.repeat(64)},
  fiscal_invoice_created:false,template_version:'proforma/1.1'};
};
