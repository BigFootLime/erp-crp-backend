type Schema=Record<string,any>;
const text={type:'string'},uuid={...text,format:'uuid'},version={type:'integer',minimum:1,maximum:2147483646};
const month={...text,pattern:'^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'},date={...text,format:'date'};
const object=(properties:Schema,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const page=(items:Schema)=>object({items:{type:'array',maxItems:25,items},total:{type:'integer',minimum:0},page:version,page_size:{type:'integer',enum:[25]}});
const result=object({event_id:uuid,forecast:ref('ClientContractForecast')});
export const clientContractForecastSchemas:Schema={
  ClientContractCoverageDemand:object({id:text,kind:{...text,enum:['FIRM','FORECAST']},article_id:uuid,unit:text,
    contract_id:{...uuid,nullable:true},contract_line_id:{...uuid,nullable:true},order_line_id:{...text,nullable:true},
    allocation_id:{...text,nullable:true},quantity:text,due_date:date,month,target_date:date}),
  ClientContractCoverageSource:object({id:text,kind:{...text,enum:['RESERVED','FREE','PRODUCTION']},article_id:uuid,unit:text,
    quantity:text,available_date:{...date,nullable:true},order_line_id:{...text,nullable:true},allocation_id:{...text,nullable:true},reference_id:text,label:text}),
  ClientContractCoverageAllocation:object({demand_id:text,source_id:text,kind:{...text,enum:['RESERVED','FREE','PRODUCTION']},quantity:text}),
  ClientContractCoverageMonth:object({month,target_date:date,end_date:date,forecast_quantity:text,firm_quantity:text,
    reserved_quantity:text,free_quantity:text,production_quantity:text,missing_quantity:text,
    cumulative_demand:text,cumulative_covered:text,cumulative_missing:text,target_overdue:{type:'boolean'}}),
  ClientContractReplenishmentMonth:object({month,target_date:date,uncovered_quantity:text,carried_quantity:text,
    lot_count:{...text,pattern:'^[0-9]+$'},lot_quantity:text,proposed_quantity:text,surplus_quantity:text,target_overdue:{type:'boolean'}}),
  ClientContractCoverage:object({contract_id:uuid,contract_version:version,generated_at:{...text,format:'date-time'},
    planning_revision:{...text,nullable:true},start_month:month,months:{type:'integer',minimum:1,maximum:36},readonly:{type:'boolean',enum:[true]},snapshot_hash:{...text,pattern:'^[a-f0-9]{64}$'},
    lines:{type:'array',items:object({contract_line_id:uuid,replenishment_qty:text,article:ref('ClientContractArticle'),months:{type:'array',maxItems:36,items:ref('ClientContractCoverageMonth')},
      replenishment_projection:{type:'array',maxItems:36,items:ref('ClientContractReplenishmentMonth')}})},
    demands:{type:'array',maxItems:5000,items:ref('ClientContractCoverageDemand')},sources:{type:'array',maxItems:10000,items:ref('ClientContractCoverageSource')},
    allocations:{type:'array',items:ref('ClientContractCoverageAllocation')},issues:{type:'array',items:object({code:text,message:text,reference_id:text},['code','message'])}}),
  ClientContractForecast:object({id:uuid,contract_id:uuid,contract_line_id:uuid,root_article_id:uuid,unit_id:uuid,
    article_snapshot:ref('ClientContractArticle'),month,quantity:{...text,pattern:'^[0-9]+(\\.[0-9]{1,3})?$'},delivery_due:date,estimate_date:date,
    status:{...text,enum:['ACTIVE','CANCELLED']},version,created_at:{...text,format:'date-time'},updated_at:{...text,format:'date-time'},updated_by:version,actor_label:text,
    converted_quantity:text,remaining_quantity:text},['id','contract_id','contract_line_id','root_article_id','unit_id','article_snapshot','month','quantity','delivery_due','estimate_date','status','version','created_at','updated_at','updated_by','actor_label']),
  ClientContractForecastResult:result,
  ClientContractForecastList:object({...page(ref('ClientContractForecast')).properties,start_month:month,months:{type:'integer',minimum:1,maximum:36},
    client_active:{type:'boolean'},contract_active:{type:'boolean'}}),
  ClientContractForecastHistory:object({forecast:ref('ClientContractForecast'),history:page(object({id:uuid,action:{...text,enum:['SAVE','CANCEL']},
    reason:{...text,nullable:true},contract_version:version,created_at:{...text,format:'date-time'},actor_label:text,
    previous_snapshot:{allOf:[ref('ClientContractForecast')],nullable:true},result_payload:result})),
    conversions:page(object({id:uuid,quantity:text,forecast_version_before:version,created_at:{...text,format:'date-time'},actor_label:text,
      commande_id:text,numero:text,customer_reference:text,commande_ligne_id:text,initial_due_date:date,current_due_date:{...date,nullable:true},current_qty:text}))}),
  ClientContractForecastCommand:{oneOf:[object({action:{...text,enum:['SAVE']},expected_contract_version:version,contract_line_id:uuid,
    month,expected_version:{...version,nullable:true},quantity:{type:'number',minimum:0,maximum:1_000_000_000,multipleOf:0.001},delivery_due:date,
    estimate_date:date,reason:{...text,minLength:3,maxLength:500,nullable:true}}),object({action:{...text,enum:['CANCEL']},
    expected_contract_version:version,forecast_id:uuid,expected_version:version,reason:{...text,minLength:3,maxLength:500}})],discriminator:{propertyName:'action'}},
};
export function clientContractForecastOperation(key:string,operation:Schema):Schema {
  const root='/clients/{id}/contracts/{contractId}/forecasts';
  if(key==='get /clients/{id}/contracts/{contractId}/coverage')return {...operation,summary:'Calculer la couverture mensuelle cumulative du contrat',
    description:'Lecture cohérente : ferme réellement restant + estimation non convertie, stock FREE NEW libéré par la qualité et OF producteurs engagés à temps. Chaque source est partagée une fois entre tous les contrats et commandes concurrentes ; les réservations et parts de regroupement restent dédiées. Ne réserve rien et ne génère aucun OF. Une cible passée est conservée. Les anciens appels CADRE non rapprochés, livraisons historiques sans allocation, unités incohérentes ou périmètres incomplets empêchent une synthèse automatique.',
    parameters:[{name:'id',in:'path',required:true,schema:text},{name:'contractId',in:'path',required:true,schema:uuid},
      {name:'start_month',in:'query',required:false,schema:month},{name:'months',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:36,default:12}}],
    responses:{...operation.responses,'200':{description:'Synthèse en lecture seule et preuves propres au contrat.',content:{'application/json':{schema:ref('ClientContractCoverage')}}},
      '404':{description:'Client ou contrat introuvable.'},'409':{description:'Définition technique, appels CADRE historiques ou livraisons à rapprocher.'},
      '422':{description:'Horizon ou périmètre trop grand ; aucune synthèse partielle.'}}};
  if(![`get ${root}`,`get ${root}/{forecastId}/history`,`post ${root}/commands`].includes(key))return operation;
  const history=key.endsWith('/history'),write=key.startsWith('post ');
  const parameters:Schema[]=[{name:'id',in:'path',required:true,schema:{...text,minLength:1,maxLength:128,pattern:'^[a-zA-Z0-9_-]+$'}},
    {name:'contractId',in:'path',required:true,schema:uuid}];
  if(history)parameters.push({name:'forecastId',in:'path',required:true,schema:uuid});
  const response=(name:string,description:string)=>({description,content:{'application/json':{schema:ref(name)}}});
  const errors={...operation.responses,'404':{description:'Client, contrat ou estimation introuvable.'},
    '409':{description:'Version, article, statut ou clé périmés. Aucun changement partiel.'},
    '422':{description:'Mois, quantité, échéance ou motif invalide.'}};
  if(write)return {...operation,summary:'Enregistrer, réviser ou retirer une estimation mensuelle client',
    description:'Une estimation n’est pas une commande ferme et ne réserve aucun stock. Une révision conserve le mois, la famille, l’unité et le snapshot article initial, et ne peut descendre sous la quantité déjà convertie. Retirer supprime uniquement le reste prévisionnel ; les appels fermes et allocations sont conservés. Motif obligatoire pour réviser/retirer. Conserver exactement la commande et la clé en cas de réponse incertaine.',
    parameters:[...parameters,{name:'Idempotency-Key',in:'header',required:true,schema:uuid}],
    requestBody:{required:true,content:{'application/json':{schema:ref('ClientContractForecastCommand')}}},
    responses:{...errors,'200':response('ClientContractForecastResult','Résultat initial rejoué.'),'201':response('ClientContractForecastResult','Estimation, historique, audit et outbox enregistrés ensemble.'),
      '503':{description:'Résultat incertain : conserver la même commande et la même clé.'}},'x-cerp-idempotency':'required'};
  parameters.push({name:'page',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:100000,default:1}});
  if(!history)parameters.push({name:'start_month',in:'query',required:false,schema:month,description:'Mois courant Europe/Paris par défaut.'},
    {name:'months',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:36,default:12}});
  return {...operation,summary:history?'Historique immuable des estimations':'Estimations mensuelles du contrat client',parameters,
    responses:{...errors,'200':response(history?'ClientContractForecastHistory':'ClientContractForecastList','Lecture cohérente, sans création de commande, réservation ou OF.')}};
}
