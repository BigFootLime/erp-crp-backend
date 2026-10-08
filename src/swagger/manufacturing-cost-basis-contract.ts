import { stockOpeningBasisOperation } from './stock-opening-basis-contract';
const decimal={type:'string',pattern:'^\\d+(?:\\.\\d{1,12})?$'};
const uuid={type:'string',format:'uuid'};
const digest={type:'string',pattern:'^[0-9a-f]{64}$'};
export function manufacturingCostBasisOperation(key:string,operation:Record<string,unknown>) {
  if(!/^\b(get|post) \/margins\/of\/\{ofId\}\/manufacturing-basis(?:\/candidates\/\{snapshotId\})?$/.test(key)) return stockOpeningBasisOperation(key,operation);
  const preview=key.includes('/candidates/'),write=key.startsWith('post ');
  const parameters:Array<Record<string,unknown>>=[{name:'ofId',in:'path',required:true,schema:{type:'string',pattern:'^[1-9]\\d{0,18}$'}}];
  if(preview) parameters.push({name:'snapshotId',in:'path',required:true,schema:uuid});
  const candidate={type:'object',required:['of_id','margin_snapshot_id','source_sha256','eligible','issues','quantity_good','total_cost_ht','currency','source_reliability'],
    properties:{of_id:{type:'string'},margin_snapshot_id:uuid,source_sha256:digest,eligible:{type:'boolean'},
      issues:{type:'array',items:{type:'string'}},quantity_good:{...decimal,nullable:true},total_cost_ht:{...decimal,nullable:true},
      currency:{type:'string',enum:['EUR']},source_reliability:{type:'string',enum:['DECLARED']},
      piece_technique_id:{...uuid,nullable:true},piece_technique_version_id:{...uuid,nullable:true},margin_as_of:{type:'string',nullable:true}}};
  const basis={type:'object',required:['id','of_id','margin_snapshot_id','quantity_good','total_cost_ht','currency','source_reliability','source_sha256','source_valid','created_by','created_at'],
    properties:{id:uuid,of_id:{type:'string'},margin_snapshot_id:uuid,quantity_good:decimal,total_cost_ht:decimal,
      currency:{type:'string',enum:['EUR']},source_reliability:{type:'string',enum:['DECLARED']},source_sha256:digest,
      source_valid:{type:'boolean'},created_by:{type:'integer'},created_at:{type:'string'}}};
  const response=preview?candidate:{type:'object',required:write?['basis','replayed']:['basis'],
    properties:{basis:{...basis,nullable:!write},...(write?{replayed:{type:'boolean'}}:{})}};
  return {...operation,summary:preview?'Préparer une base de coût fabriqué':write?'Déclarer la base de coût fabriqué':'Consulter la base de coût fabriqué',
    description:'Coût et quantité repris d’un recalcul ACTUAL sauvegardé de cet OF. Déclaration explicite et immuable, toujours DECLARED ; aucune promotion d’estimation en valeur vérifiée. Les opérations doivent être closes et les données de quantité et de temps actualisées. Aucune entrée financière, activation CUMP ou modification de stock physique. Une réception déjà projetée exige une correction distincte.',
    parameters,...(write?{requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,
      required:['request_id','margin_snapshot_id','expected_source_sha256'],properties:{request_id:uuid,margin_snapshot_id:uuid,expected_source_sha256:digest}}}}}}:{}),
    responses:{...((operation.responses as Record<string,unknown>)??{}),
      '200':{description:write?'Validation idempotente déjà enregistrée.':'Base proposée ou déclarée.',headers:{'Cache-Control':{schema:{type:'string',enum:['no-store']}}},content:{'application/json':{schema:response}}},
      ...(write?{'201':{description:'Base déclarée ; preuve et audit enregistrés dans une même transaction.',content:{'application/json':{schema:response}}}}:{}),
      '404':{description:'OF introuvable.'},'409':{description:'Base incomplète, périmée, déjà déclarée, demande contradictoire ou mise à jour concurrente.'}},
    'x-cerp-rbac':[...((operation['x-cerp-rbac'] as string[])??[]),write?'margin:snapshot':'margin:read_costs']};
}
