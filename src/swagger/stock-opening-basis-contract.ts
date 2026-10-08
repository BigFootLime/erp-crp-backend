const uuid={type:'string',format:'uuid'};
const digest={type:'string',pattern:'^[0-9a-f]{64}$'};
const decimal={type:'string',pattern:'^(0|[1-9][0-9]{0,25})(\\.[0-9]{1,12})?$'};
export function stockOpeningBasisOperation(key:string,operation:Record<string,unknown>) {
  if(!/^(get|post) \/margins\/stock-opening\/\{articleId\}\/\{unit\}\/(candidate|basis)$/.test(key))return operation;
  const candidate=key.endsWith('/candidate'),write=key.startsWith('post ');
  const basis={type:'object',properties:{id:uuid,article_id:uuid,owner_key:{type:'string',enum:['COMPANY']},
    stock_unit:{type:'string'},currency:{type:'string',enum:['EUR']},quantity:decimal,total_value_ht:decimal,
    document_id:uuid,document_sha256:digest,source_reliability:{type:'string',enum:['DECLARED']},
    source_sha256:digest,source_valid:{type:'boolean'},created_by:{type:'integer'},created_at:{type:'string'}}};
  const response=candidate?{type:'object',required:['article_id','owner','unit','currency','eligible','quantity',
    'source_sha256','source_reliability','documents','documents_truncated','issues'],properties:{article_id:uuid,
    owner:{type:'string',enum:['COMPANY']},unit:{type:'string'},currency:{type:'string',enum:['EUR']},eligible:{type:'boolean'},
    quantity:{...decimal,nullable:true},source_sha256:digest,source_reliability:{type:'string',enum:['DECLARED']},
    documents:{type:'array',maxItems:100,items:{type:'object',properties:{id:uuid,name:{type:'string'},sha256:digest}}},
    documents_truncated:{type:'boolean'},issues:{type:'array',items:{type:'string'}}}}:
    {type:'object',required:write?['basis','replayed']:['basis'],properties:{basis:{...basis,nullable:!write},
      ...(write?{replayed:{type:'boolean'}}:{})}};
  const content={'application/json':{schema:response}};
  return {...operation,summary:candidate?'Préparer la valeur du stock d’ouverture':write?'Déclarer la valeur du stock d’ouverture':'Consulter la valeur du stock d’ouverture',
    description:'Quantité entreprise issue des captures immuables, après contrôle LEVEL/BATCH et exclusion du stock client. Montant EUR déclaré explicitement avec un document actif de cet article et son empreinte ; aucune valeur catalogue reconstituée. Déclaration immuable autorisée uniquement avant initialisation du projecteur. Le projecteur reste PREPARED ; aucune mutation de stock physique.',
    parameters:[{name:'articleId',in:'path',required:true,schema:uuid},{name:'unit',in:'path',required:true,schema:{type:'string',minLength:1,maxLength:32}}],
    ...(write?{requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,
      required:['request_id','expected_source_sha256','document_id','expected_document_sha256','total_value_ht'],
      properties:{request_id:uuid,expected_source_sha256:digest,document_id:uuid,expected_document_sha256:digest,total_value_ht:decimal}}}}}}:{}),
    responses:{...((operation.responses as Record<string,unknown>)??{}),
      '200':{description:write?'Déclaration identique déjà enregistrée.':'Proposition ou base déclarée.',content},
      ...(write?{'201':{description:'Base DECLARED, document et audit conservés dans une même transaction.',content}}:{}),
      '404':{description:'Article introuvable.'},'409':{description:'Quantités incohérentes, document modifié, base déjà déclarée ou ouverture déjà engagée.'}},
    'x-cerp-rbac':[...((operation['x-cerp-rbac'] as string[])??[]),write?'margin:snapshot':'margin:read_costs']};
}
