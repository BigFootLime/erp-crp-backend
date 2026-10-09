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
  if(!["get /clients/{id}/contracts","get /clients/{id}/contracts/articles","get /clients/{id}/contracts/{contractId}","post /clients/{id}/contracts/commands"].includes(key))return operation;
  const response=(name:string,description:string)=>({description,content:{"application/json":{schema:ref(name)}}});
  const parameters:Schema[]=[{name:"id",in:"path",required:true,schema:clientId}];
  if(key.endsWith("/{contractId}"))parameters.push({name:"contractId",in:"path",required:true,schema:uuid});
  const errors={...operation.responses,"404":{description:"Client ou contrat introuvable."},"409":{description:"Version, référence, clé ou article indisponible. Aucun changement partiel."},
    "422":{description:"Définition ou famille d'article invalide."},"503":{description:"Résultat incertain : conserver strictement la même commande et clé."}};
  if(key.startsWith("post "))return {...operation,summary:"Créer, modifier ou clôturer un contrat de la fiche client",parameters:[...parameters,{name:"Idempotency-Key",in:"header",required:true,schema:uuid}],
    "x-cerp-idempotency":"required",requestBody:{required:true,content:{"application/json":{schema:ref("ClientContractCommand")}}},
    responses:{...errors,"200":response("ClientContractResult","Résultat initial rejoué."),"201":response("ClientContractResult","Contrat, lignes, historique, audit et temps réel enregistrés ensemble.")}};
  const articles=key.endsWith("/articles"),detail=key.endsWith("/{contractId}");
  parameters.push(articles?{name:"q",in:"query",required:false,schema:{...text,maxLength:160,default:""}}
    :{name:"page",in:"query",required:false,schema:{type:"integer",minimum:1,maximum:100000,default:1}});
  return {...operation,summary:articles?"Articles client validés à leur indice applicable":detail?"Définition du contrat et historique de ses versions":"Contrats de la fiche client",
    parameters,responses:{...errors,"200":response(articles?"ClientContractArticleOptions":detail?"ClientContractDetail":"ClientContractList","Référentiel canonique, sans réécriture des commandes historiques.")}};
}
