import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {registrySchema,databaseLabel,ManagerError,type Registry,type ManagedInstance} from './model';

/** One broker owns this registry. Atomic durable replacement never truncates it. */
export class ManagedRegistry {
  private tail:Promise<unknown>=Promise.resolve();
  private data:Registry={version:1,next_ordinal:2,instances:[],commands:[]};
  private lockNonce=randomUUID();
  private locked=false;
  constructor(private readonly file:string){}
  async initialize() {
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o750});
    const directory=await fs.lstat(path.dirname(this.file));if(!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('MANAGED_REGISTRY_DIRECTORY_INVALID');
    await this.acquireLock();
    try {const stat=await fs.lstat(this.file);if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_REGISTRY_FILE_INVALID');this.data=registrySchema.parse(JSON.parse(await fs.readFile(this.file,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;await this.persist(this.data);}
  }
  private async acquireLock(){
    const file=`${this.file}.lock`;
    try{const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify({pid:process.pid,nonce:this.lockNonce}));await h.sync();this.locked=true;}finally{await h.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      const stat=await fs.lstat(file);if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_REGISTRY_LOCK_INVALID');
      const lock=JSON.parse(await fs.readFile(file,'utf8'));if(!Number.isSafeInteger(lock.pid) || lock.pid<1) throw new Error('MANAGED_REGISTRY_LOCK_INVALID');
      let dead=false;try{process.kill(lock.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
      if(!dead) throw new Error('MANAGED_REGISTRY_ALREADY_RUNNING');
      await fs.unlink(file);await this.acquireLock();
    }
  }
  async close(){await this.tail;if(!this.locked)return;const file=`${this.file}.lock`,lock=JSON.parse(await fs.readFile(file,'utf8'));if(lock.nonce!==this.lockNonce || lock.pid!==process.pid) throw new Error('MANAGED_REGISTRY_LOCK_CHANGED');await fs.unlink(file);this.locked=false;}
  snapshot():Registry {return structuredClone(this.data);}
  find(id:string) {return this.snapshot().instances.find(i=>i.id===id);}
  private async persist(data:Registry) {
    registrySchema.parse(data);const temp=`${this.file}.${randomUUID()}.tmp`,handle=await fs.open(temp,'wx',0o600);
    try {await handle.writeFile(JSON.stringify(data)+'\n');await handle.sync();}finally{await handle.close();}
    await fs.rename(temp,this.file);
    this.data=data;
    if(process.platform!=='win32'){const dir=await fs.open(path.dirname(this.file),'r');try{await dir.sync();}finally{await dir.close();}}
  }
  private change<T>(work:(r:Registry)=>T):Promise<T> {
    const operation=this.tail.then(async()=>{const draft=this.snapshot(),result=work(draft);await this.persist(draft);return result;});
    this.tail=operation.catch(()=>undefined);return operation;
  }
  async command(operation:'CREATE'|'DELETE'|'RETRY',actorId:number,key:string,id?:string,confirmation?:string) {
    return this.change(r=>{
      const hash=createHash('sha256').update(JSON.stringify({operation,id:id??null,confirmation:confirmation??null})).digest('hex');
      const existing=r.commands.find(c=>c.key===key);
      if(existing){if(existing.actor_id!==actorId || existing.request_hash!==hash) throw new ManagerError(409,'MANAGED_KEY_REUSED','Cette demande concerne une autre action.');return {instance:structuredClone(r.instances.find(i=>i.id===existing.instance_id)!),replayed:true};}
      const at=new Date().toISOString();let instance:ManagedInstance;
      if(operation==='CREATE') {
        instance={id:`cerp_test_${randomUUID().replace(/-/g,'')}`,ordinal:r.next_ordinal++,state:'CREATING',created_at:at,updated_at:at,port:null,template_version:null,error_code:null};r.instances.push(instance);
      } else {
        const found=r.instances.find(i=>i.id===id);
        if(!found) throw new ManagerError(404,'MANAGED_NOT_FOUND','Cette base Test est introuvable.');
        if(operation==='RETRY') {
          if(found.state!=='FAILED') throw new ManagerError(409,'MANAGED_RETRY_STATE_INVALID','Cette base n’attend pas une reprise de création.');
          found.state='CREATING';found.error_code=null;found.updated_at=at;instance=found;
          r.commands.push({key,actor_id:actorId,operation,instance_id:instance.id,request_hash:hash,created_at:at});return {instance:structuredClone(instance),replayed:false};
        }
        if(confirmation!==databaseLabel(found.ordinal)) throw new ManagerError(422,'MANAGED_CONFIRMATION_REQUIRED','Recopiez le nom exact de la base pour confirmer.');
        if(found.state==='CREATING') throw new ManagerError(409,'MANAGED_BUSY','La création est encore en cours.');
        instance=found;if(found.state!=='DELETED'){found.state='DELETING';found.error_code=null;found.updated_at=at;}
      }
      r.commands.push({key,actor_id:actorId,operation,instance_id:instance.id,request_hash:hash,created_at:at});
      return {instance:structuredClone(instance),replayed:false};
    });
  }
  async update(id:string,patch:Partial<Pick<ManagedInstance,'state'|'port'|'template_version'|'error_code'>>) {return this.change(r=>{const row=r.instances.find(i=>i.id===id);if(!row) throw new Error('MANAGED_INSTANCE_MISSING');Object.assign(row,patch,{updated_at:new Date().toISOString()});return structuredClone(row);});}
}
