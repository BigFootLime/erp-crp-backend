// Reads one JSON line on stdin. Never pass a password as a command argument.
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
require('ts-node/register/transpile-only');
const {prepareOwnerBootstrap}=require('../../src/managed-tests/owner-bootstrap');
async function main(){
 const [output,...extra]=process.argv.slice(2),root=path.resolve(__dirname,'../..');
 if(!output || extra.length || !path.isAbsolute(output) || path.resolve(output).startsWith(root+path.sep))throw new Error('PRIVATE_BOOTSTRAP_DESTINATION_REQUIRED');
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 const raw=await new Promise((resolve,reject)=>{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(Buffer.byteLength(input)>4096 || input.includes('\u0003')){reject(new Error('PRIVATE_BOOTSTRAP_INPUT_INVALID'));process.stdin.destroy();}else if(/[\r\n]/.test(input)){process.stdin.destroy();try{resolve(JSON.parse(input.trim()));}catch{reject(new Error('PRIVATE_BOOTSTRAP_INPUT_INVALID'));}}});process.stdin.on('end',()=>reject(new Error('PRIVATE_BOOTSTRAP_INPUT_REQUIRED')));});
 const result=await prepareOwnerBootstrap(raw),directory=path.dirname(output);
 await fs.mkdir(directory,{recursive:true,mode:0o700});if((await fs.lstat(directory)).isSymbolicLink())throw new Error('PRIVATE_BOOTSTRAP_DESTINATION_INVALID');
 if(process.platform==='win32'){
  const account=`${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  await promisify(execFile)(path.join(process.env.SystemRoot,'System32','icacls.exe'),[directory,'/inheritance:r','/grant:r',`${account}:(OI)(CI)(F)`,'SYSTEM:(OI)(CI)(F)'],{windowsHide:true});
 }else await fs.chmod(directory,0o700);
 const handle=await fs.open(output,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(result)+'\n');await handle.sync();}finally{await handle.close();}
 if(process.platform==='win32'){
  const account=`${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  await promisify(execFile)(path.join(process.env.SystemRoot,'System32','icacls.exe'),[output,'/inheritance:r','/grant:r',`${account}:(F)`,'SYSTEM:(F)'],{windowsHide:true});
 }else await fs.chmod(output,0o600);
 process.stdout.write('PRIVATE_OWNER_BOOTSTRAP_PREPARED; MFA_REQUIRED_ON_FIRST_LOGIN; NOT_INSTALLED\n');
}
main().catch(()=>{process.stderr.write('PRIVATE_OWNER_BOOTSTRAP_PREPARATION_FAILED\n');process.exitCode=1;});
