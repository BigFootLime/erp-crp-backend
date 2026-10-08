const nullableDecimal={type:'string',nullable:true,pattern:'^-?\\d+(?:\\.\\d{1,12})?$'};
export function stockValuationOperation(key:string,operation:Record<string,unknown>) {
  if(key!=='get /stock/articles/{id}/valuation')return operation;
  return { ...operation,summary:'Rapprocher le CUMP et le stock réel d’un article',
    description:'Lecture sans mutation. Le CUMP reste inconnu si le projecteur est inactif, en retard, si la quantité diffère du stock utilisable ou si une preuve manque. Stock client séparé et exclu de la valeur entreprise. Montants et sources financiers masqués sans le droit prix existant. Douze décimales internes ; aucun prix catalogue ni conversion implicite.',
    parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],
    responses:{ ...((operation.responses as Record<string,unknown>)??{}),
      '200':{description:'Quantités rapprochées et valeur uniquement lorsqu’elle est justifiée et autorisée.',
        headers:{'Cache-Control':{schema:{type:'string',enum:['no-store']}}},
        content:{'application/json':{schema:{type:'object',required:['article_id','observed_at','projector_mode','prices_visible','positions','issues'],
          properties:{article_id:{type:'string',format:'uuid'},code:{type:'string'},designation:{type:'string'},observed_at:{type:'string'},
            projector_mode:{type:'string',enum:['PREPARED','ACTIVE']},formula_version:{type:'string'},prices_visible:{type:'boolean'},
            issues:{type:'array',items:{type:'string'}},positions:{type:'array',items:{type:'object',
              required:['scope','physical_quantity','projected_quantity','status','value','unit_cost','reliability','source_ref','issues'],
              properties:{scope:{type:'object',required:['articleId','owner','unit','currency'],properties:{articleId:{type:'string',format:'uuid'},owner:{type:'string'},unit:{type:'string'},currency:{type:'string'}}},
                physical_quantity:nullableDecimal,projected_quantity:nullableDecimal,
                status:{type:'string',enum:['PREPARED','PENDING','MISMATCH','UNKNOWN','AVAILABLE','CLIENT_OWNED']},
                value:nullableDecimal,unit_cost:nullableDecimal,reliability:{type:'string',enum:['UNKNOWN','DECLARED','VERIFIED']},
                source_ref:{type:'string',nullable:true},issues:{type:'array',items:{type:'string'}}}}}}}}}},
      '404':{description:'Article introuvable.'}},
    'x-cerp-rbac':[...((operation['x-cerp-rbac'] as string[])??[]),'canViewArticleCosts:monetaryRedaction'] };
}
