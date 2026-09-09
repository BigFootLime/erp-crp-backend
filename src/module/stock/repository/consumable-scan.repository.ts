import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { parseIdentificationPayload } from '../../identification/domain/identification';

/** Resolve a CERP label inside the stock transaction; a revoked label cannot be
 * used between the preview and the actual issue/depletion confirmation. */
export async function assertConsumableScanTx(tx:Pick<PoolClient,'query'>,scan:string,expected:{articleId?:string|null;lotId?:string|null;legacyCodes:Array<string|null|undefined>}){
  if(/^CERP:/i.test(scan.trim())){
    const publicId=parseIdentificationPayload(scan);
    const label=(await tx.query<{status:string;entity_type:string;entity_id:string}>(
      'SELECT status,entity_type,entity_id FROM public.identification_labels WHERE public_id=$1::uuid FOR SHARE',[publicId])).rows[0];
    if(!label||label.status!=='ACTIVE')throw new HttpError(409,'CONSUMABLE_LABEL_INACTIVE','Cette étiquette est inconnue, invalidée ou remplacée. Relisez l’étiquette actuelle.');
    if(label.entity_type==='STOCK_ARTICLE'&&label.entity_id===expected.articleId||label.entity_type==='STOCK_LOT'&&label.entity_id===expected.lotId)return;
  }else if(expected.legacyCodes.some(code=>code?.toLocaleUpperCase('fr')===scan.trim().toLocaleUpperCase('fr')))return;
  throw new HttpError(422,'CONSUMABLE_SCAN_MISMATCH','L’étiquette scannée ne correspond pas à l’article ou au conditionnement à confirmer.');
}
