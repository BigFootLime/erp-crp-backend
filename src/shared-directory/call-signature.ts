import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {siteIdSchema} from './model';
function message(site:string,method:string,path:string,body:Buffer,at:number,nonce:string){return [site,method.toUpperCase(),path,String(at),nonce,createHash('sha256').update(body).digest('hex')].join('\n');}
export function signDirectoryCall(site:string,key:string,method:string,path:string,body:Buffer,now=Date.now()){
 siteIdSchema.parse(site);if(!/^[a-f0-9]{64}$/.test(key))throw new Error('DIRECTORY_CALL_KEY_INVALID');
 const nonce=randomUUID(),at=Math.floor(now/1000);
 return {'X-CERP-Directory-Site':site,'X-CERP-Directory-Time':String(at),'X-CERP-Directory-Nonce':nonce,'X-CERP-Directory-Signature':createHmac('sha256',Buffer.from(key,'hex')).update(message(site,method,path,body,at,nonce)).digest('hex')};
}
export function verifyDirectoryCall(headers:Record<string,string|undefined>,keys:ReadonlyMap<string,string>,method:string,path:string,body:Buffer,now=Date.now()){
 const site=siteIdSchema.parse(headers['x-cerp-directory-site']),key=keys.get(site),at=Number(headers['x-cerp-directory-time']),nonce=headers['x-cerp-directory-nonce']??'',signature=headers['x-cerp-directory-signature']??'';
 if(!key || !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(at) || Math.abs(Math.floor(now/1000)-at)>30 || !/^[a-f0-9-]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/.test(signature))throw new Error('DIRECTORY_CALL_REJECTED');
 const expected=createHmac('sha256',Buffer.from(key,'hex')).update(message(site,method,path,body,at,nonce)).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new Error('DIRECTORY_CALL_REJECTED');
 return {site,nonce,expires_at:new Date(now+60_000)};
}
