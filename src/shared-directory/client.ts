import {signDirectoryCall} from './call-signature';
import {directorySessionSchema,siteIdSchema} from './model';
export const LOCAL_DIRECTORY_ENDPOINT='http://127.0.0.1:8085/internal/directory';
export const WIREGUARD_DIRECTORY_ENDPOINT='http://10.90.0.2:8086/internal/directory';
/** The site comes from a verified startup pool, never an HTTP header. */
export class DirectoryClient {
 private readonly base:string;
 constructor(base:string,private readonly site:string,private readonly key:string){
  siteIdSchema.parse(site);
  if(base!==LOCAL_DIRECTORY_ENDPOINT&&base!==WIREGUARD_DIRECTORY_ENDPOINT)throw new Error('DIRECTORY_ENDPOINT_INVALID');
  this.base=base;
 }
 async call<T>(operation:string,payload:unknown):Promise<T>{
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(operation))throw new Error('DIRECTORY_OPERATION_INVALID');
  const path=`/internal/directory/${operation}`,body=Buffer.from(JSON.stringify(payload));
  let response:Response,result:any;
  try{
   response=await fetch(`${this.base}/${operation}`,{method:'POST',headers:{...signDirectoryCall(this.site,this.key,'POST',path,body),'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000),redirect:'error'});
   result=await response.json();
  }catch{
   const error=Object.assign(new Error('L’annuaire commun est momentanément indisponible.'),{status:503,code:'DIRECTORY_UNAVAILABLE'});throw error;
  }
  if(!response.ok){const error=new Error(typeof result.message==='string'?result.message:'L’annuaire commun est momentanément indisponible.') as Error&{status:number;code:string};error.status=response.status;error.code=result.code??'DIRECTORY_UNAVAILABLE';throw error;}
  return result as T;
 }
 async validate(token:string){return directorySessionSchema.parse(await this.call('validate-session',{directory_session:token}));}
 async downloadAvatar(session:string,assetId:string){
  const path='/internal/directory/avatar-content',body=Buffer.from(JSON.stringify({directory_session:session,asset_id:assetId}));
  let response:Response;
  try{response=await fetch(`${this.base}/avatar-content`,{method:'POST',headers:{...signDirectoryCall(this.site,this.key,'POST',path,body),'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000),redirect:'error'});}catch{throw Object.assign(new Error('L’annuaire commun est momentanément indisponible.'),{status:503,code:'DIRECTORY_UNAVAILABLE'});}
  if(!response.ok){const value=await response.json();throw Object.assign(new Error(value.message??'Avatar indisponible.'),{status:response.status,code:value.code??'MEDIA_NOT_FOUND'});}
  const mime=response.headers.get('content-type')?.split(';')[0];
  if(!mime||!['image/png','image/jpeg','image/gif','image/webp'].includes(mime)||Number(response.headers.get('content-length'))>10*1024*1024)throw new Error('DIRECTORY_AVATAR_RESPONSE_INVALID');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>10*1024*1024)throw new Error('DIRECTORY_AVATAR_RESPONSE_INVALID');
  return {bytes,mime};
 }
}
