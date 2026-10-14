import {readHostConfig} from './host-config';
import {ManagedHostWorker} from './worker-host';
import {prepareTemplate} from './template';

async function main(){
  if(process.platform!=='linux' || process.getuid?.()!==0) throw new Error('MANAGED_CONTROL_ROOT_REQUIRED');
  const config=await readHostConfig(),worker=new ManagedHostWorker(config),[action,id,rawOrdinal,...rest]=process.argv.slice(2);
  if(rest.length) throw new Error('MANAGED_CONTROL_ARGUMENTS_INVALID');let result:unknown;
  if(action==='status' && !id) result=await worker.status();
  else if(action==='prepare-template' && !id) result=await prepareTemplate(config);
  else if(action==='create' && id && rawOrdinal && /^\d+$/.test(rawOrdinal)) result=await worker.create(id,Number(rawOrdinal));
  else if(action==='delete' && id && rawOrdinal && /^\d+$/.test(rawOrdinal)) result=await worker.delete(id,Number(rawOrdinal));
  else throw new Error('MANAGED_CONTROL_ARGUMENTS_INVALID');
  process.stdout.write(JSON.stringify(result)+'\n');
}
void main().catch(error=>{process.stderr.write(`${error instanceof Error && /^MANAGED_[A-Z_]+$/.test(error.message) ? error.message:'MANAGED_CONTROL_FAILED'}\n`);process.exitCode=1;});
