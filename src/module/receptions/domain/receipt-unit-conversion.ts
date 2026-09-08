import {HttpError} from "../../../utils/httpError";
const normalized=(unit:string|null|undefined)=>unit?.trim().toUpperCase()??"";
export type ReceiptUnitConversion={receiptUnit:string;stockUnit:string;coefficient:number};
export function receiptUnitConversion(input:{receiptUnit:string|null;articleUnit:string|null;purchase?:{unit:string|null;stockUnit:string|null;coefficient:number|null}|null}):ReceiptUnitConversion{
  const receiptUnit=input.receiptUnit?.trim()||input.purchase?.unit?.trim()||input.articleUnit?.trim();
  const stockUnit=input.articleUnit?.trim();
  if(!receiptUnit||!stockUnit)throw new HttpError(422,"RECEPTION_UNIT_REQUIRED","Renseignez l’unité de réception et l’unité de stock de l’article.");
  if(input.purchase?.unit&&normalized(receiptUnit)!==normalized(input.purchase.unit))throw new HttpError(422,"RECEPTION_PURCHASE_UNIT_MISMATCH","La quantité reçue doit être saisie dans l’unité de la commande fournisseur.");
  if(normalized(receiptUnit)===normalized(stockUnit))return {receiptUnit,stockUnit,coefficient:1};
  const coefficient=input.purchase?.coefficient;
  if(normalized(input.purchase?.stockUnit)!==normalized(stockUnit)||!coefficient||!Number.isFinite(coefficient)||coefficient<=0){
    throw new HttpError(422,"RECEPTION_CONVERSION_REQUIRED","Complétez la conversion de l’unité d’achat vers l’unité de stock avant la réception.");
  }
  return {receiptUnit,stockUnit,coefficient};
}
export function convertedStockQuantity(received:number,coefficient:number){
  if(!Number.isFinite(received)||received<=0||!Number.isFinite(coefficient)||coefficient<=0)throw new HttpError(422,"RECEPTION_CONVERSION_INVALID","Quantité ou coefficient de conversion invalide.");
  const raw=received*coefficient,rounded=Math.round(raw*1000)/1000;
  if(!Number.isFinite(raw)||rounded<=0||Math.abs(raw-rounded)>1e-8)throw new HttpError(422,"RECEPTION_CONVERSION_PRECISION","La conversion doit produire une quantité de stock positive avec trois décimales maximum.");
  return rounded;
}
