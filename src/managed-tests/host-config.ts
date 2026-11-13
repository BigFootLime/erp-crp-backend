import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
const absolute=z.string().refine(v=>path.isAbsolute(v) && !v.includes('\0') && !v.split(/[\\/]/).includes('..'),'Absolute trusted path required');
export const hostConfigSchema=z.object({control_root:absolute,data_root:absolute,admin_database_url:z.string().url(),source_env:absolute,template_database:z.string().regex(/^cerp_test_template_[a-z0-9_]{1,35}$/),template_version:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),api_release:absolute,app_user:z.string().regex(/^[a-z_][a-z0-9_-]{0,30}$/),app_group:z.string().regex(/^[a-z_][a-z0-9_-]{0,30}$/),minimum_free_memory_mb:z.number().int().min(256),minimum_free_disk_mb:z.number().int().min(512),pg_dump:absolute,pg_restore:absolute,systemctl:absolute,directory_id:z.string().guid().optional(),directory_callers_file:absolute.optional()}).strict();
export type ManagedHostConfig=z.infer<typeof hostConfigSchema>;
export async function readHostConfig(file='/etc/cerp-managed-tests/host.json') {
  const stat=await fs.lstat(file);
  if(!stat.isFile() || stat.isSymbolicLink() || (process.platform!=='win32' && (stat.uid!==0 || (stat.mode&0o077)!==0))) throw new Error('MANAGED_CONFIG_NOT_PRIVATE');
  const config=hostConfigSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));
  for(const directory of [config.control_root,config.api_release]){const stat=await fs.lstat(directory);if(!stat.isDirectory() || stat.isSymbolicLink() || (process.platform!=='win32' && (stat.uid!==0 || (stat.mode&0o022)!==0))) throw new Error('MANAGED_HOST_ROOT_NOT_PROTECTED');}
  const source=await fs.lstat(config.source_env);if(!source.isFile() || source.isSymbolicLink() || (process.platform!=='win32' && (source.uid!==0 || (source.mode&0o077)!==0))) throw new Error('MANAGED_SOURCE_ENV_NOT_PRIVATE');
  const url=new URL(config.admin_database_url);
  if(!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname!=='/postgres') throw new Error('MANAGED_POSTGRES_AUTHORITY_INVALID');
  return config;
}
export function childPath(root:string,...segments:string[]) {
  const result=path.resolve(root,...segments),relative=path.relative(path.resolve(root),result);
  if(!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('MANAGED_PATH_OUTSIDE_ROOT');
  return result;
}
/** Refuse symlink/junction ancestors before any privileged file operation. */
export async function checkedChild(root:string,...segments:string[]) {
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('MANAGED_ROOT_INVALID');
  const resolved=childPath(root,...segments);let current=path.resolve(root);
  for(const part of path.relative(current,resolved).split(path.sep)){current=path.join(current,part);try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()) throw new Error('MANAGED_PATH_SYMLINK');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') break;throw error;}}
  return resolved;
}
