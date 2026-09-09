// Runs only against the separate QA1047 loopback runtime and fictional account.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
if(process.env.CERP_CONSUMABLES_QA_WRITE!=='1047')throw new Error('Explicit test opt-in required');
const base='http://127.0.0.1:5148/api/v1',checks=[],terminalIds=[];
let jwt;
async function call(path,{body,headers={},method,expected=200}={}){
  const response=await fetch(base+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const payload=await response.json();
  assert.equal(response.status,expected,`${path}: ${payload.code??''} ${payload.message??payload.error?.message??''}`);
  return payload;
}
const web=()=>({Authorization:`Bearer ${jwt}`});
try{
  const login=await call('/auth/login',{body:{username:'QA1047_WEB',password:'QA1047-Web-Only!2026'}});jwt=login.token;
  assert.ok(jwt,'Login token');
  const options=await call('/terminals/admin/options',{headers:web()});
  const warehouse=options.warehouses[0]?.id;assert.ok(warehouse,'Warehouse fixture');
  const site=`QA1047-${Date.now()}`;
  const create=async kind=>{
    const enrolled=await call('/terminals/admin',{headers:web(),body:{label:`QA1047 ${kind}`,kind,site_code:site,machine_id:null,warehouse_id:warehouse},expected:201});terminalIds.push(enrolled.terminal_id);
    const paired=await call('/terminals/pair',{body:{code:enrolled.code,kind}});
    const headers={'X-Terminal-Device':paired.device_token};
    const bootstrap=await call('/terminals/bootstrap',{headers});assert.equal(bootstrap.terminal.kind,kind);assert.equal(bootstrap.terminal.machine_id,null);assert.equal(bootstrap.terminal.warehouse_id,warehouse);
    return headers;
  };
  const receipt=await create('RECEPTION'),procurement=await create('OF_PROCUREMENT');checks.push('Two apps paired to a site and warehouse without a machine');
  await call('/terminals/me/pin',{method:'PUT',headers:web(),body:{site_code:site,pin:'1047'}});
  const own=await call('/terminals/me/pin',{headers:web()});assert.ok(own.sites.some(s=>s.site_code===site&&s.configured));assert.ok(!JSON.stringify(own).includes('1047"'));checks.push('Personal PIN configured by its own web account');
  await call('/terminals/me/pin',{method:'PUT',headers:web(),body:{site_code:site,pin:'1047',user_id:1},expected:400});checks.push('Own PIN route rejects another account identifier');
  const r=await call('/terminals/identify',{headers:receipt,body:{pin:'1047',app_version:'qa1047'}}),p=await call('/terminals/identify',{headers:procurement,body:{pin:'1047',app_version:'qa1047'}});
  receipt['X-Station-Session']=r.session_token;procurement['X-Station-Session']=p.session_token;
  await call('/terminals/session',{headers:receipt});await call('/terminals/session',{headers:procurement});checks.push('Same personal PIN opens independent authorized app sessions');
  const expected=await call('/terminals/reception/expected-lines?pageSize=5',{headers:receipt});assert.ok(Array.isArray(expected.items));assert.equal(typeof expected.permissions.receive,'boolean');
  await call('/terminals/reception/drafts',{headers:receipt});await call('/terminals/logistics/magasins',{headers:receipt});await call(`/terminals/logistics/emplacements?magasin_id=${warehouse}&is_active=true&is_scrap=false`,{headers:receipt});
  const categories=await call('/terminals/logistics/article-categories',{headers:receipt});assert.ok(categories.items.some(c=>c.code==='consommable'));
  const articles=await call('/stock/articles?business_category=consommable&pageSize=200',{headers:web()});assert.ok(articles.items.length>0);assert.ok(articles.items.every(a=>a.article_categories.includes('consommable')));
  const found=await call('/terminals/procurement/ofs?q=QA1047',{headers:procurement});assert.ok(Array.isArray(found.items));
  if(found.items[0]){const coverage=await call(`/terminals/procurement/ofs/${found.items[0].id}`,{headers:procurement});assert.ok(Array.isArray(coverage.needs));}
  checks.push('Receipt queue, draft recovery, destinations and OF coverage use live scoped routes');
  await call('/terminals/procurement/ofs',{headers:receipt,expected:403});await call('/terminals/reception/expected-lines',{headers:procurement,expected:403});
  await call('/terminals/operator/worklist',{headers:receipt,expected:403});await call('/terminals/admin',{headers:receipt,expected:401});
  await call('/terminals/session',{headers:{...receipt,'X-Station-Session':p.session_token},expected:403});checks.push('Cross-app, operator, administration and foreign-device sessions refused');
  await call('/terminals/me/pin',{method:'PUT',headers:web(),body:{site_code:site,pin:'2047'}});
  await call('/terminals/session',{headers:receipt,expected:401});await call('/terminals/session',{headers:procurement,expected:401});checks.push('Personal PIN change revokes both existing sessions');
  const next=await call('/terminals/identify',{headers:receipt,body:{pin:'2047'}});receipt['X-Station-Session']=next.session_token;
  await call('/terminals/session/lock',{headers:receipt,body:{}});await call('/terminals/session',{headers:receipt,expected:401});checks.push('Manual lock is enforced by the server');
  for(let i=0;i<5;i++)await call('/terminals/identify',{headers:procurement,body:{pin:'9999'},expected:401});
  await call('/terminals/identify',{headers:procurement,body:{pin:'2047'},expected:429});checks.push('Five incorrect PIN attempts block the next attempt');
  await call('/terminals/admin/pins/revoke',{headers:web(),body:{site_code:site,user_id:login.user.id}});
  await writeFile('.qa/terminal-http-evidence.json',JSON.stringify({date:new Date().toISOString(),database:'cerp_test',checks},null,2));
  process.stdout.write(JSON.stringify({result:'PASS',checks},null,2)+'\n');
}catch(e){process.stderr.write(JSON.stringify({result:'FAIL',message:e.message,checks})+'\n');process.exitCode=1;}
finally{for(const id of terminalIds){try{await call(`/terminals/admin/${id}/revoke`,{headers:web(),body:{reason:'Fin de recette fictive QA1047'}});}catch(e){process.stderr.write(JSON.stringify({cleanup:'FAILED',id,message:e.message})+'\n');process.exitCode=1;}}}
