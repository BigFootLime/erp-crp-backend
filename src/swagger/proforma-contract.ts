type Schema = Record<string, unknown>;
const text: Schema = { type: "string" }, uuid: Schema = { ...text, format: "uuid" }, integer: Schema = { type: "integer", minimum: 1 };
const money: Schema = { ...text, pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$" }, quantity: Schema = { ...text, pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,3})?$" };
const hash: Schema = { ...text, pattern: "^[a-fA-F0-9]{64}$" }, status: Schema = { ...text, enum: ["DRAFT","ISSUED","CANCELLED"] };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", additionalProperties: false, properties, required });
const array = (items: Schema, extra: Schema = {}): Schema => ({ type: "array", items, ...extra });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true });
const companyTotal = object({ billed_client_id: text, company_name: text, total_ex_tax: money, tax_amount: money, total_incl_tax: money });
const selectedAffair = object({ allocation_id: integer, billing_parts: array(object({ billed_client_id: text, quantity }), { minItems: 1, maxItems: 100 }) });
const selection = { client_id: { ...text,minLength:1,maxLength:120 }, currency: { ...text,pattern:"^[A-Z]{3}$",default:"EUR" }, affairs: array(selectedAffair,{minItems:1,maxItems:200}) };
const snapshot: Schema = { type:"object",additionalProperties:true,description:"Server-owned commercial or issuer snapshot. No caller-provided snapshot is accepted." };
const blocker = object({ code: text, message: text });
const fundingPart = object({ id: uuid, allocation_id: integer, billed_client_id: text, company_name: text,
  requiredAmount: money, paidAmount: money, remainingAmount: money, status: { ...text,enum:["UNPAID","PARTIALLY_PAID","PAID","INVALID"] }, blockers: array(blocker) });
const item = object({ id: uuid,reference:text,client_id:text,status,row_version:integer,currency:text,
  created_at:{...text,format:"date-time"},issued_at:nullable({...text,format:"date-time"}),company_totals:array(companyTotal),client_code:nullable(text),company_name:text });

export const proformaSchemas: Record<string, Schema> = {
  ProformaSelection: object(selection,["client_id","affairs"]),
  ProformaCreate: object({ ...selection,preview_hash:hash },["client_id","affairs","preview_hash"]),
  ProformaConfirmation: object({ expected_version:integer,preview_hash:hash,confirm:{type:"boolean",enum:[true]} }),
  ProformaRefresh: object({ ...selection,expected_version:integer,preview_hash:hash,confirm:{type:"boolean",enum:[true]} },["client_id","affairs","expected_version","preview_hash","confirm"]),
  ProformaCancellation: object({ expected_version:integer,reason:{...text,minLength:3,maxLength:1000},confirm:{type:"boolean",enum:[true]} }),
  ProformaReceiptAssignment: object({ payment_allocation_id:uuid,assignments:array(object({proforma_billing_part_id:uuid,deposit_source_id:uuid,amount:money}),{minItems:1,maxItems:200}) }),
  ProformaReceiptRelease: object({ amount:money,reason:{...text,minLength:3,maxLength:1000},confirm:{type:"boolean",enum:[true]} }),
  ProformaReceiptAssignmentResult: object({ id:uuid,reference:text,status,row_version:integer,payment_allocation_id:uuid,
    assignments:array(object({id:uuid,deposit_source_id:uuid,amount:money})),correlation_id:uuid,idempotent_replay:{type:"boolean"} }),
  ProformaReceiptReleaseResult: object({ id:uuid,reference:text,status,row_version:integer,release_id:uuid,assignment_id:uuid,released_amount:money,correlation_id:uuid,idempotent_replay:{type:"boolean"} }),
  ProformaPreview: object({ version:{type:"integer",enum:[1]},client_id:text,client_snapshot:snapshot,currency:text,
    affairs:array(object({allocation_id:integer,source_revision:hash,source_snapshot:snapshot,billing_parts:array(object({
      billed_client_id:text,quantity,billed_client_snapshot:snapshot,unit_price_ex_tax:{...text,pattern:"^(?:0|[1-9]\\d*)(?:\\.\\d{1,4})?$"},
      discount_percent:text,global_discount_percent:text,tax_rate_percent:text,total_ex_tax:money,tax_amount:money,total_incl_tax:money,
    }))})),company_totals:array(companyTotal),preview_hash:hash }),
  ProformaCommandResult: object({ id:uuid,reference:text,status,row_version:integer,correlation_id:uuid,idempotent_replay:{type:"boolean"} }),
  ProformaList: object({items:array(item),total:{type:"integer",minimum:0},as_of:text,page:integer,pageSize:integer}),
  ProformaDetail: object({ id:uuid,reference:text,status,row_version:integer,preview_payload:ref("ProformaPreview"),issued_snapshot:nullable(snapshot),
    created_at:text,issued_at:nullable(text),funding:array(fundingPart) }),
  ProformaTermsDecision: object({expected_version:{type:"integer",minimum:0},requirement:{...text,enum:["NOT_REQUIRED","PROFORMA"]},
    reason:{...text,minLength:3,maxLength:1000},confirm:{type:"boolean",enum:[true]} }),
  ProformaTermsResult: object({ allocation_id:integer,requirement:{...text,enum:["NOT_REQUIRED","PROFORMA"]},row_version:integer,correlation_id:uuid,idempotent_replay:{type:"boolean"} }),
};

export function proformaOperation(key: string, original: Schema): Schema {
  const definitions: Record<string,{summary:string;request?:string;response:string;write?:boolean;create?:boolean}> = {
    'get /proformas':{summary:'Lister les proformas et les sociétés facturées',response:'ProformaList'},
    'post /proformas/preview':{summary:'Calculer la proforma depuis les commandes',request:'ProformaSelection',response:'ProformaPreview'},
    'post /proformas':{summary:'Préparer une proforma et ses affaires',request:'ProformaCreate',response:'ProformaCommandResult',write:true,create:true},
    'get /proformas/{id}':{summary:'Lire la proforma figée et sa couverture de règlements',response:'ProformaDetail'},
    'get /proformas/{id}/preview':{summary:'Actualiser l’aperçu commercial du brouillon',response:'ProformaPreview'},
    'post /proformas/{id}/preview':{summary:'Préparer les modifications du brouillon',request:'ProformaSelection',response:'ProformaPreview'},
    'post /proformas/{id}/refresh':{summary:'Enregistrer les modifications confirmées du brouillon',request:'ProformaRefresh',response:'ProformaCommandResult',write:true},
    'post /proformas/{id}/issue':{summary:'Émettre la proforma commerciale sans facture fiscale',request:'ProformaConfirmation',response:'ProformaCommandResult',write:true},
    'post /proformas/{id}/cancel':{summary:'Annuler la proforma après régularisation des acomptes et règlements',request:'ProformaCancellation',response:'ProformaCommandResult',write:true},
    'post /proformas/{id}/receipts':{summary:'Ventiler un règlement existant entre les affaires',request:'ProformaReceiptAssignment',response:'ProformaReceiptAssignmentResult',write:true},
    'post /proformas/{id}/receipts/{assignmentId}/release':{summary:'Libérer une ventilation sans annuler le paiement',request:'ProformaReceiptRelease',response:'ProformaReceiptReleaseResult',write:true},
    'post /proformas/affaires/{allocationId}/terms':{summary:'Confirmer les conditions de paiement d’une affaire',request:'ProformaTermsDecision',response:'ProformaTermsResult',write:true},
  };
  const entry=definitions[key]; if(!entry)return original;
  const parameters: Schema[]=[];
  if(key.includes('{id}'))parameters.push({name:'id',in:'path',required:true,schema:uuid});
  if(key.includes('{allocationId}'))parameters.push({name:'allocationId',in:'path',required:true,schema:integer});
  if(key.includes('{assignmentId}'))parameters.push({name:'assignmentId',in:'path',required:true,schema:uuid});
  if(entry.write)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{...text,minLength:8,maxLength:200}});
  if(key==='get /proformas') for(const [name,schema] of Object.entries({q:{...text,maxLength:160},client_id:text,status,page:integer,pageSize:{type:'integer',minimum:1,maximum:100}}))parameters.push({name,in:'query',schema});
  const success={description:'Server-derived commercial result. No bank transfer or fiscal invoice is executed by this operation.',content:{'application/json':{schema:ref(entry.response)}}};
  return {...original,summary:entry.summary,
    description:'Finance permissions, canonical order amounts, billed-company quantity distribution and immutable source evidence. Mutations require idempotency, recheck the preview/version and commit audit/realtime/replay receipts atomically. Unknown historical payment terms require an explicit reasoned decision. Proforma is distinct from fiscal deposit and final invoices.',
    parameters,...(entry.request?{requestBody:{required:true,content:{'application/json':{schema:ref(entry.request)}}}}:{}),
    responses:{...(original.responses as Schema),'200':success,...(entry.create?{'201':success}:{})}};
}
