import {z} from 'zod';

export const managedDatabaseIdSchema=z.string().regex(/^cerp_test_[a-f0-9]{32}$/);
export const ordinalSchema=z.number().int().min(2).max(Number.MAX_SAFE_INTEGER-1);
export const managedStateSchema=z.enum(['CREATING','READY','FAILED','DELETING','DELETED']);
export const instanceSchema=z.object({id:managedDatabaseIdSchema,ordinal:ordinalSchema,state:managedStateSchema,created_at:z.string().datetime(),updated_at:z.string().datetime(),port:z.number().int().min(1024).max(65535).nullable(),template_version:z.string().max(100).nullable(),error_code:z.string().regex(/^[A-Z_0-9]{1,80}$/).nullable()}).strict();
const commandSchema=z.object({key:z.string().uuid(),actor_id:z.number().int().positive(),operation:z.enum(['CREATE','DELETE','RETRY']),instance_id:managedDatabaseIdSchema,request_hash:z.string().regex(/^[a-f0-9]{64}$/),created_at:z.string().datetime()}).strict();
export const registrySchema=z.object({version:z.literal(1),next_ordinal:ordinalSchema,instances:z.array(instanceSchema),commands:z.array(commandSchema)}).strict().superRefine((r,ctx)=>{
  if(new Set(r.instances.map(i=>i.id)).size!==r.instances.length || new Set(r.instances.map(i=>i.ordinal)).size!==r.instances.length || new Set(r.commands.map(c=>c.key)).size!==r.commands.length || r.instances.some(i=>i.ordinal>=r.next_ordinal) || r.commands.some(c=>!r.instances.some(i=>i.id===c.instance_id))) ctx.addIssue({code:'custom',message:'Invalid registry identity or counter'});
});
export type ManagedInstance=z.infer<typeof instanceSchema>;
export type Registry=z.infer<typeof registrySchema>;
export const databaseLabel=(ordinal:number)=>`Base Test ${ordinal}.0`;
export function publicInstance(i:ManagedInstance) {return {id:i.id,ordinal:i.ordinal,label:databaseLabel(i.ordinal),state:i.state,created_at:i.created_at,error_code:i.error_code};}
export function requireManagedId(value:string) {return managedDatabaseIdSchema.parse(value);}
export class ManagerError extends Error {
  constructor(public status:number,public code:string,message:string){super(message);}
}
