import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {siteIdSchema} from './model';
import {requireManagedId} from '../managed-tests/model';
const rowsSchema=z.array(z.object({site:siteIdSchema,key:z.string().regex(/^[a-f0-9]{64}$/)}).strict());
async function protectedFile(file:string){
 const parent=await fs.lstat(path.dirname(file)),stat=await fs.lstat(file);
 if(!parent.isDirectory()||parent.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||(process.platform==='linux'&&(parent.uid!==0||(parent.mode&0o022)!==0||stat.uid!==0||(stat.mode&0o037)!==0)))throw new Error('DIRECTORY_CALLERS_NOT_PRIVATE');
 return stat;
}
export async function readDirectoryCallerKeys(file:string){
 await protectedFile(file);const rows=rowsSchema.parse(JSON.parse(await fs.readFile(file,'utf8'))),keys=new Map(rows.map(row=>[row.site,row.key]));
 if(keys.size!==rows.length)throw new Error('DIRECTORY_CALLERS_INVALID');return keys;
}
/** The root helper's existing flock serializes writers. Never edits Prod/common keys. */
export async function updateManagedCallerKey(file:string,site:string,remove=false){
 requireManagedId(site);const stat=await protectedFile(file),keys=await readDirectoryCallerKeys(file),prior=keys.get(site);
 if(!remove&&prior)return prior;if(remove&&!prior)return null;
 const key=remove?null:randomBytes(32).toString('hex');if(key)keys.set(site,key);else keys.delete(site);
 const temporary=`${file}.${randomBytes(8).toString('hex')}.tmp`,handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify([...keys].map(([site,key])=>({site,key})))+'\n');if(process.platform==='linux'){await handle.chown(0,stat.gid);await handle.chmod(stat.mode&0o777);}await handle.sync();}finally{await handle.close();}
 await fs.rename(temporary,file);return key;
}
