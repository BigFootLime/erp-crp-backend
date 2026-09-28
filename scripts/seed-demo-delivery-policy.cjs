// Synthetic policy for the isolated presentation database. Requires the built API.
const pool=require('../dist/config/database').default;
const repo=require('../dist/module/qualite/repository/quality-delivery-policy.repository');
(async()=>{try{
if((await pool.query('SELECT current_database() db')).rows[0].db!=='cerp_demo')throw Error('Demo database required');
if((await pool.query("SELECT id FROM quality_delivery_release_policy WHERE status='ACTIVE'")).rowCount) {console.log('Existing active demo policy preserved');return;}
const reviewer=(await pool.query("SELECT id FROM users WHERE username='DEMO_QUALITE' AND role='Responsable Qualité' AND is_superadmin=false")).rows[0];
if(!reviewer)throw Error('Synthetic quality reviewer required');
const actor={user_id:reviewer.id,role:'Responsable Qualité',request_id:null,ip:null,user_agent:'CERP isolated demo setup'};
let p=await repo.repoCreateDeliveryPolicy({actor,idempotencyKey:'demo-delivery-policy-20260929-create',body:{label:'Politique fictive — présentation CERP+',justification:'Données synthétiques uniquement dans cerp_demo. Contrôle intégral des trois pièces et décision indépendante avant expédition.',valid_from:'2026-09-01T00:00:00.000Z',valid_to:null,rules:{schema:'cerp.quality.delivery-release-policy.v2',engine:'CERP_QUALITY_ELIGIBILITY_V1',aggregate_scope:'ALL_DELIVERY_ALLOCATIONS',derogation_mode:'FORBIDDEN',required_control_triggers:['LOT_RELEASE'],require_independent_decider:true,required_documents:[]}}});
for(const target_status of ['IN_REVIEW','SIGNED','ACTIVE'].slice(['DRAFT','IN_REVIEW','SIGNED'].indexOf(p.status)))p=await repo.repoTransitionDeliveryPolicy({id:p.id,actor,idempotencyKey:`demo-delivery-policy-20260929-${target_status}`,body:{expected_updated_at:p.updated_at,target_status,reason:'Configuration synthétique de la démonstration, sans portée industrielle réelle.',...(target_status==='SIGNED'?{signature_reference:'DEMO-QUALITE-SYNTHETIQUE-20260929',document_reference:'DEMO-POLITIQUE-EXPEDITION-SYNTHETIQUE-V1'}:{})}});
console.log(JSON.stringify({id:p.id,status:p.status,synthetic:true}));
}catch(e){console.error({code:e.code,constraint:e.constraint,message:e.message});process.exitCode=1}finally{await pool.end()}})();
