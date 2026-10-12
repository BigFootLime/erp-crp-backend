import { HttpError } from '../../../utils/httpError';
import { proposeReceivedMaterialBars,receivedMaterialBarLengths } from '../../stock/domain/material-bar-receipt';
import type { ConfirmGroupedReceipt } from '../validators/grouped-receipts.validators';

export type GroupedMaterialLine = {
    unit:string|null;stockUnit:string|null;coefficient:number;stockManaged:boolean;qualityRequired:boolean;
    processingPolicy?:'STANDARD'|'PIECES_CONTROLE_EMBALLAGE';
    flowContext?:{material?:{barToCut?:boolean;sourceLengthMm?:number|null}|null};
};
const directMillimetres=(line:GroupedMaterialLine)=>line.stockManaged&&!line.qualityRequired
    &&line.processingPolicy!=='PIECES_CONTROLE_EMBALLAGE'&&line.stockUnit?.trim().toLowerCase()==='mm';

export function groupedMaterialBarProposal(line:GroupedMaterialLine,quantity:number){
    return proposeReceivedMaterialBars({required:Boolean(directMillimetres(line)&&line.flowContext?.material?.barToCut),
        receiptUnit:line.unit??'',stockUnit:line.stockUnit??'',coefficient:line.coefficient,quantity,sourceLengthMm:line.flowContext?.material?.sourceLengthMm});
}

/** Validate each supplier lot before recording anything. Quality-controlled
 * material is received physically first; geometry is confirmed on accepted stock. */
export function groupedMaterialBarPortions(line:GroupedMaterialLine,choice:ConfirmGroupedReceipt['lines'][number]){
    if(choice.materialBars&&choice.packs.length)throw new HttpError(422,'MATERIAL_BAR_PACK_ASSIGNMENT_REQUIRED','Répartissez les barres sur chaque lot fournisseur reçu.');
    const portions=choice.packs.length?choice.packs:[{quantity:choice.quantity,supplierLotCode:choice.supplierLotCode,materialBars:choice.materialBars}];
    const direct=directMillimetres(line),required=direct&&line.flowContext?.material?.barToCut===true;
    for(const portion of portions){
        if(portion.materialBars&&!direct)throw new HttpError(422,'MATERIAL_BAR_RECEIPT_DEFERRED','Les barres se confirment lors de l’entrée en stock de matière acceptée.');
        if(required&&!portion.materialBars)throw new HttpError(422,'MATERIAL_BAR_RECEIPT_REQUIRED','Confirmez le nombre et les longueurs des barres reçues pour chaque lot fournisseur.');
        if(portion.materialBars)receivedMaterialBarLengths(portion.materialBars,portion.quantity*line.coefficient);
    }
    return portions;
}
