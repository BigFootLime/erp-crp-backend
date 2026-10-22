import {createHmac,timingSafeEqual} from 'node:crypto';
export function commonAccessReplyMac(kind:'source'|'site',key:string,nonce:string,body:Buffer){
 const path=kind==='source'?'/internal/cerp/common-access-v1':'/internal/directory/common-access-policy';
 return createHmac('sha256',Buffer.from(key,'hex')).update(`CERP-COMMON-ACCESS-${kind.toUpperCase()}-RESPONSE-v1\n${path}\n${nonce}\n`).update(body).digest();
}
export function verifyCommonAccessReply(kind:'source'|'site',key:string,nonce:string,body:Buffer,signature:string){
 return /^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(commonAccessReplyMac(kind,key,nonce,body),Buffer.from(signature,'hex'));
}
