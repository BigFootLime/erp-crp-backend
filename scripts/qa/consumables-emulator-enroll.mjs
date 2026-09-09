// Synthetic QA1047 device only. Credentials stay in memory; no production endpoint.
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
if (process.env.CERP_CONSUMABLES_QA_WRITE !== '1047' || !process.env.CERP_QA_MOBILE_ROOT || !process.env.ANDROID_HOME) throw new Error('Explicit QA opt-in, mobile root and emulator SDK required');
const base='http://127.0.0.1:5148/api/v1';
async function call(path, body, token, method=body?'POST':'GET') {
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  const p=await r.json();if(!r.ok)throw new Error(`${path}: ${r.status} ${p.code??p.message??''}`);return p;
}
const login=await call('/auth/login',{username:'QA1047_WEB',password:'QA1047-Web-Only!2026'});
const path='.qa/emulator-terminal.json';
if(process.argv.includes('--cleanup')) {
  const data=JSON.parse(await readFile(path,'utf8'));
  await call(`/terminals/admin/${data.terminalId}/revoke`,{reason:'Fin de recette émulateur fictif QA1047'},login.token);
  await call('/terminals/admin/pins/revoke',{site_code:data.site,user_id:login.user.id},login.token);
  console.log('Synthetic emulator terminal and personal test PIN revoked');
} else {
  const site=`QA1047-EMU-${Date.now()}`, kind=process.argv.includes('--procurement')?'OF_PROCUREMENT':'RECEPTION';
  const options=await call('/terminals/admin/options',undefined,login.token);
  const enrolled=await call('/terminals/admin',{label:`QA1047 EMULATOR ${kind}`,kind,site_code:site,machine_id:null,warehouse_id:options.warehouses[0].id},login.token);
  await writeFile(path,JSON.stringify({terminalId:enrolled.terminal_id,site,kind}));
  await call('/terminals/me/pin',{site_code:site,pin:'1047'},login.token,'PUT');
  const ui=process.env.CERP_QA_MOBILE_ROOT+'/tests/native/android_ui.py';
  const run=(...args)=>execFileSync('python',['-X','utf8',ui,...args],{env:process.env,stdio:'pipe'});
  run('fill','Adresse du serveur CERP','http://127.0.0.1:5148/api/v1');
  execFileSync(process.env.ANDROID_HOME+'/platform-tools/adb.exe',['-s','emulator-5554','shell','input','keyevent','4'],{stdio:'pipe'});
  run('scroll','Code temporaire d’appairage'); run('fill','Code temporaire d’appairage',enrolled.code);
  execFileSync(process.env.ANDROID_HOME+'/platform-tools/adb.exe',['-s','emulator-5554','shell','input','keyevent','4'],{stdio:'pipe'});
  console.log('Synthetic enrollment entered on emulator; ready for user-interface confirmation.');
}
