const uuid={type:'string',format:'uuid'},sha={type:'string',pattern:'^[a-f0-9]{64}$'};
const decimal={type:'string',pattern:'^-?[0-9]{1,26}(?:\\.[0-9]{1,12})?$'};
export function materialInvoiceReconciliationOperation(key:string,operation:Record<string,unknown>) {
  if(key!=='get /supplier-invoices/{id}/material-reconciliation')return operation;
  const lot={type:'object',required:['lot_id','lot_code','article_id','unit','received_quantity','remaining_quantity',
    'consumed_quantity','invoice_amount_ht','booked_amount_ht','variance_ht','stock_variance_ht','consumed_variance_ht','receipt_refs'],
    properties:{lot_id:uuid,lot_code:{type:'string'},article_id:uuid,unit:{type:'string'},received_quantity:decimal,
      remaining_quantity:decimal,consumed_quantity:decimal,invoice_amount_ht:decimal,booked_amount_ht:decimal,variance_ht:decimal,
      stock_variance_ht:decimal,consumed_variance_ht:decimal,receipt_refs:{type:'array',maxItems:500,items:{type:'object',
        required:['receipt_line_id','movement_id','entry_id','stock_sha256','acquisition_sha256','entry_sha256'],properties:{
          receipt_line_id:uuid,movement_id:uuid,entry_id:uuid,stock_sha256:sha,acquisition_sha256:sha,entry_sha256:sha}}}}};
  const line={type:'object',required:['invoice_line_id','position','order_line_id','calculable','projection_ready','source_reliability',
    'invoice_amount_ht','booked_amount_ht','variance_ht','stock_variance_ht','consumed_variance_ht','issues','lots'],properties:{
      invoice_line_id:uuid,position:{type:'integer',minimum:1},order_line_id:uuid,calculable:{type:'boolean'},projection_ready:{type:'boolean'},
      source_reliability:{type:'string',enum:['DECLARED','VERIFIED','UNKNOWN']},invoice_amount_ht:{...decimal,nullable:true},
      booked_amount_ht:{...decimal,nullable:true},variance_ht:{...decimal,nullable:true},stock_variance_ht:{...decimal,nullable:true},
      consumed_variance_ht:{...decimal,nullable:true},issues:{type:'array',items:{type:'string'}},lots:{type:'array',maxItems:500,items:lot}}};
  const schema={type:'object',required:['id','row_version','method','currency','source_sha256','calculable','projection_ready','applied',
    'requires_financial_confirmation','posting_available','header_source_sha256','issues','lines'],properties:{id:uuid,
      row_version:{type:'integer',minimum:1},method:{type:'string',enum:['INVOICE_LOT_REMAINING_V1']},currency:{type:'string'},source_sha256:sha,
      calculable:{type:'boolean'},projection_ready:{type:'boolean'},applied:{type:'boolean',enum:[false]},
      requires_financial_confirmation:{type:'boolean',enum:[true]},posting_available:{type:'boolean',enum:[false]},
      header_source_sha256:{...sha,nullable:true},issues:{type:'array',items:{type:'string'}},lines:{type:'array',maxItems:500,items:line}}};
  return {...operation,summary:'Préparer le rapprochement de facture matière',
    description:'Lecture Finance protégée : facture approuvée/archives, allocation HT, coût de réception figé et filiation complète des lots. Proposition exacte à 12 décimales : écart HT ventilé entre stock restant et consommation. Lots anciens/mélangés, factures partielles/avoirs ou preuves incomplètes restent expliqués UNKNOWN. Source SHA complète ; aucun montant libre, aucune écriture ni activation CUMP. La confirmation financière sera une opération séparée.',
    parameters:[{name:'id',in:'path',required:true,schema:uuid}],
    responses:{...((operation.responses as Record<string,unknown>)??{}),'200':{description:'Proposition privée sans cache, aucune écriture.',
      content:{'application/json':{schema}}},'404':{description:'Facture introuvable.'},'409':{description:'Contrôle occupé ou dossier trop volumineux.'}},
    'x-cerp-rbac':[...((operation['x-cerp-rbac'] as string[])??[]),'supplier_invoice_read']};
}
