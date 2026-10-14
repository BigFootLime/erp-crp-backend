import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents, parseDecimal } from "./decimal-money";

export type AdvanceCreditVatSnapshot = {
  version:1;invoice_id:number;invoice_sha256:string;total_ex_tax:string;total_tax:string;total_incl_tax:string;
  entries:Array<{tax_rate:string;amount_ex_tax:string;tax_amount:string;pending_tax:string;collected_tax:string}>;
};
type TaxGroup={tax_rate:string;amount_ex_tax:string;tax_amount:string};
function invalid():never {throw new HttpError(409,"ADVANCE_CREDIT_VAT_INVALID","La correction de TVA doit être rapprochée des encaissements de l’acompte.");}

/** Cancel uncollected VAT first. Already collected VAT is corrected once by the credit. */
export function planAdvanceCreditVat(args:{invoiceId:number;invoiceSha256:string;original:readonly TaxGroup[];
  collected:ReadonlyMap<string,string>;cleared:ReadonlyMap<string,{net:string;tax:string}>;
  prior:readonly AdvanceCreditVatSnapshot[];credit:readonly TaxGroup[]}):AdvanceCreditVatSnapshot {
  if(!Number.isSafeInteger(args.invoiceId)||args.invoiceId<=0||!/^[a-f0-9]{64}$/.test(args.invoiceSha256))invalid();
  const rate=(value:string)=>formatDecimal(parseDecimal(value,4,"Taux de TVA"),4);
  const originals=new Map(args.original.map(entry=>[rate(entry.tax_rate),entry]));
  if(originals.size!==args.original.length)invalid();
  const used=new Map<string,{net:bigint;tax:bigint;pending:bigint;collected:bigint}>();
  for(const prior of args.prior){
    if(prior.version!==1||prior.invoice_id!==args.invoiceId||prior.invoice_sha256!==args.invoiceSha256)invalid();
    const qualified=readAdvanceCreditVat(prior,prior.total_ex_tax,prior.total_tax,prior.total_incl_tax);
    for(const entry of qualified.entries){const key=rate(entry.tax_rate),value=used.get(key)??{net:0n,tax:0n,pending:0n,collected:0n};
      if(!originals.has(key))invalid();value.net+=moneyToCents(entry.amount_ex_tax);value.tax+=moneyToCents(entry.tax_amount);
      value.pending+=moneyToCents(entry.pending_tax);value.collected+=moneyToCents(entry.collected_tax);used.set(key,value);}
  }
  let net=0n,tax=0n;const seen=new Set<string>();
  const entries=args.credit.map(entry=>{
    const key=rate(entry.tax_rate),original=originals.get(key);if(!original||seen.has(key))invalid();seen.add(key);
    const old=used.get(key)??{net:0n,tax:0n,pending:0n,collected:0n},netCents=moneyToCents(entry.amount_ex_tax),taxCents=moneyToCents(entry.tax_amount),
      received=moneyToCents(args.collected.get(key)??"0"),applied=args.cleared.get(key),clearedNet=moneyToCents(applied?.net??"0"),clearedTax=moneyToCents(applied?.tax??"0");
    const pending=moneyToCents(original.tax_amount)-received-old.pending;
    if(netCents<0n||taxCents<0n||pending<0n||received-old.collected-clearedTax<0n
      ||netCents+old.net+clearedNet>moneyToCents(original.amount_ex_tax)||taxCents+old.tax+clearedTax>moneyToCents(original.tax_amount))invalid();
    const pendingTax=taxCents<pending?taxCents:pending,collectedTax=taxCents-pendingTax;
    if(collectedTax>received-old.collected-clearedTax)invalid();net+=netCents;tax+=taxCents;
    return{tax_rate:key,amount_ex_tax:formatDecimal(netCents,2),tax_amount:formatDecimal(taxCents,2),pending_tax:formatDecimal(pendingTax,2),collected_tax:formatDecimal(collectedTax,2)};
  });
  return readAdvanceCreditVat({version:1,invoice_id:args.invoiceId,invoice_sha256:args.invoiceSha256,total_ex_tax:formatDecimal(net,2),
    total_tax:formatDecimal(tax,2),total_incl_tax:formatDecimal(net+tax,2),entries},formatDecimal(net,2),formatDecimal(tax,2),formatDecimal(net+tax,2));
}

export function readAdvanceCreditVat(value:unknown,net:string,tax:string,gross:string):AdvanceCreditVatSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))invalid();const data=value as AdvanceCreditVatSnapshot;
  if(data.version!==1||!Number.isSafeInteger(data.invoice_id)||data.invoice_id<=0||!/^[a-f0-9]{64}$/.test(data.invoice_sha256)||!Array.isArray(data.entries)||!data.entries.length)invalid();
  let summedNet=0n,summedTax=0n;const seen=new Set<string>();
  for(const entry of data.entries){
    const rate=parseDecimal(entry.tax_rate,4,"Taux de TVA"),key=formatDecimal(rate,4),entryNet=moneyToCents(entry.amount_ex_tax),entryTax=moneyToCents(entry.tax_amount),
      pending=moneyToCents(entry.pending_tax),collected=moneyToCents(entry.collected_tax);
    if(seen.has(key)||rate<0n||rate>1000000n||entryNet<0n||entryTax<0n||pending<0n||collected<0n||pending+collected!==entryTax||(rate===0n&&entryTax!==0n))invalid();
    seen.add(key);summedNet+=entryNet;summedTax+=entryTax;
  }
  if(summedNet!==moneyToCents(net)||summedTax!==moneyToCents(tax)||summedNet+summedTax!==moneyToCents(gross)
    ||moneyToCents(data.total_ex_tax)!==summedNet||moneyToCents(data.total_tax)!==summedTax||moneyToCents(data.total_incl_tax)!==summedNet+summedTax)invalid();
  return data;
}
