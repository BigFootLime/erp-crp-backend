import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {requireManagedId,ordinalSchema,ManagerError,type ManagedInstance} from './model';
const run=promisify(execFile);
export const helperResultSchema=z.object({id:z.string(),port:z.number().int().min(1024).max(65535).nullable(),template_version:z.string().max(100),deleted:z.boolean().optional()}).strict();
export interface TestInstanceHelper {
  status():Promise<{ready:boolean;template_version:string}>;
  create(instance:ManagedInstance):Promise<z.infer<typeof helperResultSchema>>;
  delete(instance:ManagedInstance):Promise<z.infer<typeof helperResultSchema>>;
}
/** Sudo grants only this fixed reviewed executable, never a shell or SQL tool. */
export class PrivilegedHelperClient implements TestInstanceHelper {
  private async call(args:string[]) {
    try {const {stdout}=await run('/usr/bin/sudo',['-n','/usr/local/libexec/cerp-test-control',...args],{timeout:240_000,maxBuffer:16_384,windowsHide:true});return JSON.parse(stdout);}
    catch {throw new ManagerError(503,'MANAGED_WORKER_UNAVAILABLE','Le service de création est temporairement indisponible. La demande est conservée.');}
  }
  async status(){return z.object({ready:z.boolean(),template_version:z.string().max(100)}).strict().parse(await this.call(['status']));}
  async create(i:ManagedInstance){return helperResultSchema.parse(await this.call(['create',requireManagedId(i.id),String(ordinalSchema.parse(i.ordinal))]));}
  async delete(i:ManagedInstance){return helperResultSchema.parse(await this.call(['delete',requireManagedId(i.id),String(ordinalSchema.parse(i.ordinal))]));}
}
