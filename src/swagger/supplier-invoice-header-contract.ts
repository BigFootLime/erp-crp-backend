const uuid={type:'string',format:'uuid'}, digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const money={type:'string',pattern:'^-?[0-9]{1,20}\\.[0-9]{2}$'};
export function supplierInvoiceHeaderOperation(key:string,operation:Record<string,unknown>) {
  const read=key==='get /supplier-invoices/{id}/header-allocation',approve=key==='post /supplier-invoices/{id}/approve';
  if(!read&&!approve)return operation;
  const choice={type:'object',additionalProperties:false,required:['method','expected_source_sha256'],properties:{
    method:{type:'string',enum:['PROPORTIONAL_NET_V1']},expected_source_sha256:digest}};
  const candidate={type:'object',required:['id','row_version','method','eligible','required','source_sha256','currency',
    'total_ht','lines_ht','header_difference_ht','issues','lines'],properties:{id:uuid,row_version:{type:'integer',minimum:1},
    method:{type:'string',enum:['PROPORTIONAL_NET_V1']},eligible:{type:'boolean'},required:{type:'boolean'},
    source_sha256:{...digest,nullable:true},currency:{type:'string',nullable:true},total_ht:{...money,nullable:true},
    lines_ht:{...money,nullable:true},header_difference_ht:{...money,nullable:true},issues:{type:'array',items:{type:'string'}},
    lines:{type:'array',maxItems:2000,items:{type:'object',required:['id','position','net_ht','purchase_order_line_id','header_amount_ht','total_ht'],
      properties:{id:uuid,position:{type:'integer',minimum:1},net_ht:money,purchase_order_line_id:{...uuid,nullable:true},header_amount_ht:money,total_ht:money}}}}};
  return {...operation,summary:read?'Préparer la répartition HT hors lignes':'Approuver la facture avec sa répartition contrôlée',
    description:'Proposition exacte en centimes, proportionnelle aux montants HT, sur toutes les lignes rapprochées. Aucun montant libre. Frais/remises, source fiscale, rapprochement et archives figés dans la décision append-only. Le choix est explicite ; sans lui, une différence hors lignes reste inconnue dans les coûts. Aucun stock ni coût historique modifié.',
    parameters:[{name:'id',in:'path',required:true,schema:uuid},...(approve?[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8,maxLength:200}}]:[])],
    ...(approve?{requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,
      required:['expected_version'],properties:{expected_version:{type:'integer',minimum:1},header_allocation:choice}}}}}}:{}),
    responses:{...((operation.responses as Record<string,unknown>)??{}),
      ...(read?{'200':{description:'Proposition en lecture seule, privée et sans cache.',content:{'application/json':{schema:candidate}}}}:{}),
      '404':{description:'Facture introuvable.'},'409':{description:'Version, preuve ou archive modifiée ; validation concurrente.'}},
    'x-cerp-rbac':[...((operation['x-cerp-rbac'] as string[])??[]),approve?'supplier_invoice_approve':'supplier_invoice_read']};
}
