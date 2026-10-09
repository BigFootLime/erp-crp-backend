type Schema=Record<string,any>;
const uuid={type:"string",format:"uuid"},text={type:"string"},bool={type:"boolean"};
const clientId={...text,minLength:1,maxLength:128,pattern:"^[a-zA-Z0-9_-]+$"};
const integer={type:"integer",minimum:1,maximum:2147483646};
const date={...text,format:"date",nullable:true};
const object=(properties:Schema,required=Object.keys(properties)):Schema=>({type:"object",properties,required,additionalProperties:false});
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const page=(items:Schema)=>object({items:{type:"array",maxItems:25,items},total:{type:"integer",minimum:0},page:integer,page_size:{type:"integer",enum:[25]}});
const header={id:uuid,client_id:clientId,reference:{...text,minLength:1,maxLength:100},title:{...text,minLength:1,maxLength:200},
  status:{...text,enum:["DRAFT","ACTIVE","CLOSED"]},valid_from:date,valid_until:date,version:integer,updated_at:{...text,format:"date-time"}};
const definition={reference:header.reference,title:header.title,valid_from:date,valid_until:date,status:{...text,enum:["DRAFT","ACTIVE"]},
  lines:{type:"array",minItems:1,maxItems:100,items:object({article_id:uuid,replenishment_qty:{type:"number",exclusiveMinimum:true,minimum:0,maximum:1_000_000_000,multipleOf:0.001}})}};
const existing={contract_id:uuid,expected_version:integer,reason:{...text,minLength:3,maxLength:500}};
export const clientContractSchemas:Schema={
  ClientContractCallBinding:object({contract_id:uuid,expected_version:integer,idempotency_key:uuid}),
  ClientContractCalls:page(object({id:uuid,commande_id:text,numero:text,customer_reference:text,current_customer_reference:{...text,nullable:true},
    order_date:{...text,format:"date"},created_at:{...text,format:"date-time"},contract_version:integer,actor_user_id:integer,actor_label:text,
    lines:{type:"array",items:object({id:uuid,contract_line_id:uuid,commande_ligne_id:text,article:ref("ClientContractArticle"),
      initial_qty:text,current_qty:text,initial_due_date:{...text,format:"date"},current_due_date:{...text,format:"date",nullable:true},replenishment_qty:text})}})),
  ClientContractArticle:object({article_id:uuid,root_article_id:uuid,code:text,designation:text,piece_technique_id:uuid,piece_technique_version_id:uuid,indice:text,unit_id:uuid,unit:text}),
  ClientContractLine:object({id:uuid,article_id:uuid,root_article_id:uuid,replenishment_qty:{...text,pattern:"^\\d+(\\.\\d{1,3})?$"},unit_id:uuid,unit:text,
    configured_code:text,configured_designation:text,configured_indice:text,configured_piece_technique_version_id:uuid,
    proposed_article:{allOf:[ref("ClientContractArticle")],nullable:true}}),
  ClientContract:object({...header,lines:{type:"array",maxItems:100,items:ref("ClientContractLine")}}),
  ClientContractList:object({...page(object({...header,line_count:{type:"integer",minimum:0,maximum:100}})).properties,can_write:bool,client_active:bool}),
  ClientContractDetail:object({contract:ref("ClientContract"),can_write:bool,client_active:bool,history:page(object({id:uuid,action:{...text,enum:["CREATE","UPDATE","CLOSE"]},
    reason:{...text,nullable:true},created_at:{...text,format:"date-time"},actor_user_id:integer,actor_label:text,
    previous_snapshot:{allOf:[ref("ClientContract")],nullable:true},result_payload:ref("ClientContractResult")}))}),
  ClientContractArticleOptions:object({items:{type:"array",maxItems:200,items:ref("ClientContractArticle")}}),
  ClientContractResult:object({event_id:uuid,contract:ref("ClientContract")}),
  ClientContractCommand:{oneOf:[object({action:{...text,enum:["CREATE"]},...definition}),
    object({action:{...text,enum:["UPDATE"]},...existing,...definition}),object({action:{...text,enum:["CLOSE"]},...existing})],discriminator:{propertyName:"action"}},
};
export function clientContractOperation(key:string,operation:Schema):Schema {
  if(key==="get /livraisons/preparation-cart")return {...operation,
    parameters:[...(operation.parameters??[]),{name:"include_contract_scope",in:"query",required:false,
      schema:{type:"boolean",default:false},description:"Opt in to contract_group_key, saved contract_reference and client_code on each reservation. Legacy clients retain the existing response shape."}],
    "x-cerp-delivery-contract-scope":{type:"object",required:["contract_group_key","contract_reference"],
      properties:{contract_group_key:{type:"string",pattern:"^(NONE|CONTRACT:[a-f0-9-]{36}|LEGACY_CADRE:[0-9]+)$"},contract_reference:{type:"string",nullable:true},client_code:{type:"string",nullable:true}}}};
  if(["post /livraisons","post /livraisons/from-commande/{commandeId}","post /livraisons/from-reservations",
    "put /livraisons/{id}","post /livraisons/{id}/lines","put /livraisons/{id}/lines/{lineId}",
    "post /livraisons/{id}/lignes/{lineId}/allocations","post /livraisons/{id}/status","post /livraisons/{id}/ship",
    "get /livraisons/{id}/shipment-preview"].includes(key))return {...operation,
    description:[operation.description,"Canonical source orders must share one client and one contract or all be outside contracts. Historical CADRE orders remain distinct identities pending explicit reprise. Unbound manual lines cannot enter a contract BL. Creation, edits, preparation and shipment revalidate this boundary atomically. Proforma linkage/payment validation is a separate pending increment."].filter(Boolean).join("\n\n"),
    "x-cerp-delivery-contract-boundary":true,
    responses:{...operation.responses,"409":{description:"MIXED_DELIVERY_CONTRACT, MIXED_DELIVERY_CLIENT or DELIVERY_CONTRACT_LINE_SOURCE_REQUIRED. No partial delivery or stock consumption."}}};
  if(key==="post /commandes")return {...operation,description:[operation.description,
    "Optional firm contract call in multipart data JSON: client_contract_call = {contract_id, expected_version, idempotency_key}; each line carries client_contract_line_id and the proposed validated article/PT/version/unit, requested quantity and date. Actor/key replay checks the exact parsed body and uploaded file digests. The order, immutable call snapshots, audit and outbox commit together. Reuse the exact request/key after an uncertain result."].filter(Boolean).join("\n\n"),
    "x-cerp-contract-call-binding":ref("ClientContractCallBinding"),responses:{...operation.responses,"409":{description:"Stale contract/version/article, conflicting retry key or inactive client. No partial order."},"422":{description:"Call must be firm, valid at the order date, and contain unique available contract articles with quantity and due date."}}};
  if(["patch /commandes/{id}","delete /commandes/{id}","post /commandes/{id}/duplicate"].includes(key))return {...operation,
    description:[operation.description,"A recorded contract call retains its client, contract, line IDs, article/technical version and unit. Quantity/date changes retain the original immutable snapshot. Deletion and duplication are refused; create a new call from the client contract."].filter(Boolean).join("\n\n"),
    responses:{...operation.responses,"409":{description:"Recorded contract call identity/history must be retained."}}};
  if(!["get /clients/{id}/contracts","get /clients/{id}/contracts/articles","get /clients/{id}/contracts/{contractId}","get /clients/{id}/contracts/{contractId}/calls","post /clients/{id}/contracts/commands"].includes(key))return operation;
  const response=(name:string,description:string)=>({description,content:{"application/json":{schema:ref(name)}}});
  const parameters:Schema[]=[{name:"id",in:"path",required:true,schema:clientId}];
  if(key.includes("/{contractId}"))parameters.push({name:"contractId",in:"path",required:true,schema:uuid});
  const errors={...operation.responses,"404":{description:"Client ou contrat introuvable."},"409":{description:"Version, référence, clé ou article indisponible. Aucun changement partiel."},
    "422":{description:"Définition ou famille d'article invalide."},"503":{description:"Résultat incertain : conserver strictement la même commande et clé."}};
  if(key.startsWith("post "))return {...operation,summary:"Créer, modifier ou clôturer un contrat de la fiche client",parameters:[...parameters,{name:"Idempotency-Key",in:"header",required:true,schema:uuid}],
    "x-cerp-idempotency":"required",requestBody:{required:true,content:{"application/json":{schema:ref("ClientContractCommand")}}},
    responses:{...errors,"200":response("ClientContractResult","Résultat initial rejoué."),"201":response("ClientContractResult","Contrat, lignes, historique, audit et temps réel enregistrés ensemble.")}};
  const articles=key.endsWith("/articles"),detail=key.endsWith("/{contractId}"),calls=key.endsWith("/calls");
  parameters.push(articles?{name:"q",in:"query",required:false,schema:{...text,maxLength:160,default:""}}
    :{name:"page",in:"query",required:false,schema:{type:"integer",minimum:1,maximum:100000,default:1}});
  return {...operation,summary:articles?"Articles client validés à leur indice applicable":detail?"Définition du contrat et historique de ses versions":calls?"Appels fermes du contrat, quantités et délais initiaux et actuels":"Contrats de la fiche client",
    parameters,responses:{...errors,"200":response(articles?"ClientContractArticleOptions":detail?"ClientContractDetail":calls?"ClientContractCalls":"ClientContractList","Référentiel canonique, sans réécriture des commandes historiques.")}};
}
