import { createHash } from 'node:crypto';
import { canonicalizeStockUnitCode as unit } from '../../shared/stock-unit';
import { parseCumpDecimal as decimal,formatCumpDecimal as amount,roundCumpRatio as ratio } from '../stock/domain/cump-decimal';
import { readCumpPostingSource,checkCumpTransferGroup,type CumpPostingSource } from '../stock/domain/cump-posting-source';
import { readReceiptAcquisitionFacts } from '../stock/domain/receipt-acquisition-snapshot';
import { proposeInvoiceHeaderAllocation,readApprovedInvoiceHeaderAllocation } from './supplier-invoice-header-allocation';

export const MATERIAL_RECONCILIATION_METHOD = 'INVOICE_LOT_REMAINING_V1' as const;
type Json = Record<string,unknown>;
const object=(v:unknown):Json|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Json:null;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const number=(v:unknown,signed=false):bigint=>{if(typeof v!=='string')throw Error('SOURCE_DECIMAL_MISSING');return decimal(v,signed);};
const signedRatio=(n:bigint,d:bigint)=>n<0n?-ratio(-n,d):ratio(n,d);

export type MaterialInvoiceSource={id:string;row_version:number;supplier_id:string|null;currency:string;
  document_type:string;match_id:string|null;order_id:string|null;approved:boolean;approval_id:string|null;
  header_facts:unknown;header_allocation:unknown};
export type MaterialInvoiceLine={id:string;position:number;quantity:string|null;unit:string|null;
  order_line_id:string;receipt_ids:string[];link_valid:boolean;other_invoice:boolean};
export type MaterialReceipt={receipt_stock_id:string;reception_id:string;receipt_line_id:string;movement_id:string;
  receipt_quantity:string;receipt_active:boolean;acquisition_snapshot:unknown;acquisition_sha256:string|null;
  acquisition_valid:boolean;sequence:string|null;article_id:string|null;source_snapshot:unknown;source_sha256:string|null;
  source_valid:boolean;proof_complete:boolean;entry_id:string|null;owner_key:string|null;stock_unit:string|null;
  currency:string|null;quantity_delta:string|null;movement_value:string|null;reliability:string|null;
  entry_snapshot:unknown;entry_sha256:string|null;entry_valid:boolean};
export type MaterialLot={lot_id:string;article_id:string;lot_code:string;owner_client_id:string|null;
  batches:unknown;has_opening:boolean};
export type MaterialTrace={movement_id:string;article_id:string|null;sequence:string|null;source_sha256:string|null;
  source_snapshot:unknown;source_valid:boolean;proof_complete:boolean};
export type MaterialBalance={article_id:string;unit:string;source_snapshot:unknown};
export type MaterialReconciliationSources={invoice:MaterialInvoiceSource;lines:MaterialInvoiceLine[];
  receipts:MaterialReceipt[];lots:MaterialLot[];trace:MaterialTrace[];balances:MaterialBalance[];complete:boolean};
export type MaterialLotProposal={lot_id:string;lot_code:string;article_id:string;unit:string;
  received_quantity:string;remaining_quantity:string;consumed_quantity:string;invoice_amount_ht:string;
  booked_amount_ht:string;variance_ht:string;stock_variance_ht:string;consumed_variance_ht:string;
  receipt_refs:Array<{receipt_line_id:string;movement_id:string;entry_id:string;stock_sha256:string;
    acquisition_sha256:string;entry_sha256:string}>};
export type MaterialLineProposal={invoice_line_id:string;position:number;order_line_id:string;
  calculable:boolean;projection_ready:boolean;source_reliability:'DECLARED'|'VERIFIED'|'UNKNOWN';
  invoice_amount_ht:string|null;booked_amount_ht:string|null;variance_ht:string|null;
  stock_variance_ht:string|null;consumed_variance_ht:string|null;issues:string[];lots:MaterialLotProposal[]};

/** UUIDs are extracted only to find sources, never to qualify their value. The
 * domain below corroborates every link against the immutable receipt/posting. */
export function materialReceiptScopes(receipts:MaterialReceipt[]) {
  const lots=new Set<string>(),scopes=new Map<string,{article_id:string;unit:string}>();
  for(const row of receipts) {
    const s=object(row.acquisition_snapshot),stockUnit=typeof s?.stock_unit==='string'?unit(s.stock_unit):null;
    if(uuid(s?.article_id)&&stockUnit&&stockUnit.length<=32)scopes.set(`${s.article_id}:${stockUnit}`,{article_id:s.article_id,unit:stockUnit});
    if(Array.isArray(s?.stock_lines))for(const line of s.stock_lines){const l=object(line);if(uuid(l?.lot_id))lots.add(l.lot_id);}
  }
  return {lotIds:[...lots].sort(),scopes:[...scopes.values()].sort((a,b)=>a.article_id.localeCompare(b.article_id)||a.unit.localeCompare(b.unit))};
}

function posting(row:MaterialTrace):CumpPostingSource|null {
  if(!row.proof_complete||!uuid(row.article_id)||!digest(row.source_sha256)||!row.sequence)return null;
  return readCumpPostingSource({...row,article_id:row.article_id,sequence:row.sequence,source_sha256:row.source_sha256,
    acquisition_snapshot:null,acquisition_sha256:null,acquisition_valid:null},'EUR').posting;
}

/** No financial write or freely entered amount. A complete lot lineage is
 * required: unrelated receipts, opening stock, returns and reversals stay
 * explained UNKNOWN. Quantities are never added across units/articles. */
export function proposeMaterialInvoiceReconciliation(source:MaterialReconciliationSources) {
  const invoice=source.invoice,header=proposeInvoiceHeaderAllocation(invoice.header_facts),issues:string[]=[];
  if(!source.complete)issues.push('MATERIAL_SOURCE_LIMIT_EXCEEDED');
  if(!invoice.approved||!uuid(invoice.approval_id)||!uuid(invoice.match_id)||!uuid(invoice.order_id)
    ||!uuid(invoice.supplier_id))issues.push('MATERIAL_INVOICE_APPROVAL_MISSING');
  if(invoice.document_type!=='INVOICE')issues.push('MATERIAL_CREDIT_ORIGINAL_ALLOCATION_REQUIRED');
  if(invoice.currency!=='EUR')issues.push('MATERIAL_INVOICE_CURRENCY_UNSUPPORTED');
  const fiscal=object(invoice.header_facts);
  if(fiscal?.invoice_id!==invoice.id||fiscal.currency!==invoice.currency||fiscal.match_version_id!==invoice.match_id
    ||fiscal.match_purchase_order_id!==invoice.order_id||fiscal.match_outcome!=='MATCHED'||fiscal.supplier_matches!==true)
    issues.push('MATERIAL_APPROVED_MATCH_INVALID');
  if(!header.eligible||header.source_sha256===null)issues.push(...header.issues);
  const amounts=header.required?readApprovedInvoiceHeaderAllocation(invoice.header_facts,invoice.header_allocation)
    :header.eligible?new Map(header.lines.map(line=>[line.id,line.total_ht])):null;
  if(!amounts)issues.push('MATERIAL_HEADER_APPROVAL_REQUIRED');
  if(!source.lines.length)issues.push('MATERIAL_INVOICE_LINES_MISSING');
  if(source.lines.length>500||source.receipts.length>500||source.lots.length>500||source.trace.length>2000)
    issues.push('MATERIAL_SOURCE_LIMIT_EXCEEDED');
  if(new Set(source.lines.map(l=>l.id)).size!==source.lines.length
    ||new Set(source.receipts.map(r=>r.movement_id)).size!==source.receipts.length
    ||new Set(source.lots.map(l=>l.lot_id)).size!==source.lots.length
    ||new Set(source.trace.map(t=>t.movement_id)).size!==source.trace.length)issues.push('MATERIAL_SOURCE_DUPLICATED');
  const globalIssues=[...new Set(issues)];
  const postings=new Map(source.trace.map(t=>[t.movement_id,posting(t)]));
  const lots=new Map(source.lots.map(l=>[l.lot_id,l])),claimedLots=new Map<string,Set<string>>();
  const lineReceipts=new Map(source.lines.map(l=>[l.id,source.receipts.filter(r=>l.receipt_ids?.includes(r.receipt_line_id))]));
  for(const line of source.lines)for(const r of lineReceipts.get(line.id)??[]) {
    const s=object(r.acquisition_snapshot);
    if(Array.isArray(s?.stock_lines))for(const raw of s.stock_lines) {
      const lot=object(raw)?.lot_id;if(!uuid(lot))continue;
      const owners=claimedLots.get(lot)??new Set<string>();owners.add(line.id);claimedLots.set(lot,owners);
    }
  }
  const lines:MaterialLineProposal[]=source.lines.slice(0,500).map(line=>{
    const result:MaterialLineProposal={invoice_line_id:line.id,position:line.position,order_line_id:line.order_line_id,
      calculable:false,projection_ready:false,source_reliability:'UNKNOWN',invoice_amount_ht:null,booked_amount_ht:null,
      variance_ht:null,stock_variance_ht:null,consumed_variance_ht:null,issues:[...globalIssues],lots:[]};
    const fail=(code:string)=>{result.issues.push(code);};
    if(!uuid(line.id)||!uuid(line.order_line_id)||!line.link_valid)fail('MATERIAL_INVOICE_LINE_SCOPE_INVALID');
    if(line.other_invoice)fail('MATERIAL_RECEIPT_ALREADY_INVOICED');
    if(!Array.isArray(line.receipt_ids)||!line.receipt_ids.length||line.receipt_ids.some(id=>!uuid(id))
      ||new Set(line.receipt_ids).size!==line.receipt_ids.length)fail('MATERIAL_RECEIPT_LINKS_INVALID');
    if(source.lines.some(other=>other.id!==line.id&&other.receipt_ids.some(id=>line.receipt_ids.includes(id))))
      fail('MATERIAL_RECEIPT_SHARED_BETWEEN_LINES');
    if(result.issues.length)return result;
    try {
      const target=number(amounts?.get(line.id)),invoiced=number(line.quantity),purchaseUnit=unit(line.unit);
      if(invoiced<=0n||!purchaseUnit||target<0n){fail('MATERIAL_INVOICE_QUANTITY_INVALID');return result;}
      const receipts=lineReceipts.get(line.id)??[];
      if(line.receipt_ids.some(id=>!receipts.some(r=>r.receipt_line_id===id)))fail('MATERIAL_RECEIPT_CAPTURE_MISSING');
      type LotGroup={lot:MaterialLot;unit:string;purchase:bigint;received:bigint;booked:bigint;
        receipts:MaterialReceipt[];reliability:'DECLARED'|'VERIFIED'};
      const groups=new Map<string,LotGroup>();let receivedPurchase=0n;
      for(const row of receipts) {
        const s=object(row.acquisition_snapshot),physical=object(row.source_snapshot),entry=object(row.entry_snapshot),
          entryResult=object(entry?.result),facts=readReceiptAcquisitionFacts(row.acquisition_snapshot).facts;
        if(!row.proof_complete||!row.acquisition_valid||!row.source_valid||!digest(row.acquisition_sha256)
          ||!digest(row.source_sha256)||!s||s.stock_source_sha256!==row.source_sha256||!facts
          ||source.trace.find(t=>t.movement_id===row.movement_id)?.source_sha256!==row.source_sha256
          ||facts.ownerClientId!==null||facts.order?.lineId!==line.order_line_id||facts.order.id!==invoice.order_id
          ||facts.order.supplierId!==invoice.supplier_id||facts.order.articleId!==facts.articleId
          ||facts.order.currency?.trim().toUpperCase()!==invoice.currency
          ||unit(facts.order.unit)!==purchaseUnit||unit(facts.receiptUnit)!==purchaseUnit
          ||s.movement_id!==row.movement_id||s.article_id!==row.article_id||!row.receipt_active
          ||!Array.isArray(s.receipts)||object(s.receipts[0])?.receipt_stock_id!==row.receipt_stock_id
          ||object(s.receipts[0])?.receipt_line_id!==row.receipt_line_id
          ||object(s.receipts[0])?.reception_id!==row.reception_id
          ||number(row.receipt_quantity)!==number(facts.receiptQuantity)
          ||JSON.stringify(s.stock_lines)!==JSON.stringify(physical?.lines)
          ||!postings.get(row.movement_id)||postings.get(row.movement_id)?.kind!=='RECEIPT') {
          fail('MATERIAL_RECEIPT_PROOF_INVALID');continue;
        }
        const received=number(facts.stockQuantity),purchase=number(facts.receiptQuantity),coefficient=number(facts.conversionCoefficient),
          stockUnit=unit(facts.stockUnit),lotIds=new Set((s.stock_lines as unknown[]).map(raw=>object(raw)?.lot_id));
        const residual=purchase*coefficient-received*1_000_000_000_000n;
        if(received<=0n||purchase<=0n||coefficient<=0n||!stockUnit||stockUnit.length>32
          ||(residual<0n?-residual:residual)>10_000_000_000_000_000n
          ||stockUnit===purchaseUnit&&coefficient!==1_000_000_000_000n||lotIds.size!==1) {
          fail('MATERIAL_RECEIPT_LOT_OR_CONVERSION_INVALID');continue;
        }
        const lotId=[...lotIds][0],lot=uuid(lotId)?lots.get(lotId):null;
        if(!lot||lot.article_id!==facts.articleId||lot.owner_client_id!==null||lot.has_opening
          ||claimedLots.get(lot.lot_id)?.size!==1) {fail('MATERIAL_LOT_LINEAGE_UNRESOLVED');continue;}
        if(!row.entry_valid||!uuid(row.entry_id)||!digest(row.entry_sha256)||!entry||entry.schema_version!==1||!entryResult
          ||row.owner_key!=='COMPANY'||row.currency!==invoice.currency||unit(row.stock_unit)!==stockUnit
          ||row.reliability!=='DECLARED'&&row.reliability!=='VERIFIED'
          ||entry.stock_source_sha256!==row.source_sha256||entry.acquisition_source_sha256!==row.acquisition_sha256
          ||number(row.quantity_delta)!==received||number(entryResult.quantityDelta)!==received
          ||number(row.movement_value)!==number(entryResult.movementValue)
          ||entryResult.movementReliability!==row.reliability) {fail('MATERIAL_RECEIPT_COST_UNRESOLVED');continue;}
        const group=groups.get(lot.lot_id)??{lot,unit:stockUnit,purchase:0n,received:0n,booked:0n,receipts:[],reliability:'VERIFIED'};
        if(group.unit!==stockUnit){fail('MATERIAL_LOT_UNIT_MISMATCH');continue;}
        group.purchase+=purchase;group.received+=received;group.booked+=number(row.movement_value);group.receipts.push(row);
        if(row.reliability==='DECLARED')group.reliability='DECLARED';
        groups.set(lot.lot_id,group);receivedPurchase+=purchase;
      }
      if(receivedPurchase!==invoiced)fail('MATERIAL_PARTIAL_INVOICE_ALLOCATION_REQUIRED');
      if(result.issues.length)return result;
      let before=0n,bookedTotal=0n,stockDelta=0n,consumedDelta=0n;let projectionReady=true;
      for(const group of [...groups.values()].sort((a,b)=>a.lot.lot_id.localeCompare(b.lot.lot_id))) {
        const batches=Array.isArray(group.lot.batches)?group.lot.batches:[];
        if(!Array.isArray(group.lot.batches)||batches.length>500){fail('MATERIAL_LOT_PHYSICAL_INCOMPLETE');continue;}
        let remaining=0n;
        for(const raw of batches) {
          const b=object(raw);
          if(!b||b.article_id!==group.lot.article_id||unit(typeof b.unit==='string'?b.unit:null)!==group.unit)
            {fail('MATERIAL_LOT_PHYSICAL_SCOPE_INVALID');continue;}
          const total=number(b.quantity_total),depreciated=number(b.quantity_depreciated);
          if(depreciated>total){fail('MATERIAL_LOT_PHYSICAL_QUANTITY_INVALID');continue;}remaining+=total-depreciated;
        }
        let observed=0n;const expectedReceipts=new Set(group.receipts.map(r=>r.movement_id));
        const seenReceipts=new Set<string>();
        for(const row of source.trace) {
          const p=postings.get(row.movement_id),s=object(row.source_snapshot);
          if(!p||!s||!Array.isArray(s.lines)){fail('MATERIAL_LOT_TRACE_INCOMPLETE');continue;}
          const lotLines=s.lines.map(object).filter(l=>l?.lot_id===group.lot.lot_id);
          if(!lotLines.length)continue;
          if(p.articleId!==group.lot.article_id||p.reversalOfId||lotLines.some(l=>l?.owner_client_id!==null
            ||unit(typeof l?.unit==='string'?l.unit:null)!==group.unit)) {fail('MATERIAL_LOT_TRACE_SCOPE_INVALID');continue;}
          const quantity=lotLines.reduce((sum,l)=>sum+number(l?.quantity),0n);
          if(p.transferId) {
            const transfer=[...postings.values()].filter((t):t is CumpPostingSource=>!!t&&t.transferId===p.transferId);
            const signature=(t:CumpPostingSource)=>amount((object(source.trace.find(x=>x.movement_id===t.movementId)?.source_snapshot)?.lines as unknown[])
              .map(object).filter(l=>l?.lot_id===group.lot.lot_id).reduce((sum,l)=>sum+number(l?.quantity),0n));
            if(!checkCumpTransferGroup(p,transfer)||transfer.some(t=>signature(t)!==signature(p)))fail('MATERIAL_LOT_TRANSFER_UNRESOLVED');
            continue;
          }
          if(p.kind==='RECEIPT'&&expectedReceipts.has(p.movementId)&&s.movement_type==='IN') {
            observed+=quantity;seenReceipts.add(p.movementId);
          } else if((p.kind==='ISSUE'||p.kind==='SCRAP')&&['OUT','SCRAP','DEPRECIATE'].includes(String(s.movement_type)))observed-=quantity;
          else if(p.kind!=='ZERO')fail('MATERIAL_LOT_MIXED_OR_RETURNED');
        }
        if(seenReceipts.size!==expectedReceipts.size||observed!==remaining||remaining<0n||remaining>group.received)
          fail('MATERIAL_LOT_REMAINING_NOT_RECONCILED');
        const balance=object(source.balances.find(b=>b.article_id===group.lot.article_id&&b.unit===group.unit)?.source_snapshot),
          projector=object(balance?.projector),state=object(balance?.before_state),checks=object(balance?.checks),scope=object(balance?.scope);
        const ready=balance?.eligible===true&&projector?.mode==='ACTIVE'&&projector.initialized===true&&projector.formula_version==='CERP-CUMP-1.0.0'
          &&projector.reporting_currency==='EUR'&&checks?.pending===false&&checks.blocked===false&&checks.capture_missing===false
          &&scope?.articleId===group.lot.article_id&&scope.owner==='COMPANY'&&scope.unit===group.unit&&scope.currency==='EUR'
          &&object(balance?.physical)?.eligible===true&&state?.value!==null&&state?.value!==undefined
          &&number(state?.quantity)===number(balance?.quantity)&&number(state.quantity)>=remaining
          &&(state.reliability==='DECLARED'||state.reliability==='VERIFIED')&&uuid(balance?.previous_entry_id)&&digest(balance?.previous_entry_sha256);
        if(!ready)projectionReady=false;
        const allocated=ratio(target*(before+group.purchase),invoiced)-ratio(target*before,invoiced);before+=group.purchase;
        const delta=allocated-group.booked,stock=signedRatio(delta*remaining,group.received),consumed=delta-stock;
        // Preserve the existing numeric(38,12) boundary on aggregate values.
        for(const value of [group.received,remaining,group.booked,delta,stock,consumed])number(amount(value),true);
        result.lots.push({lot_id:group.lot.lot_id,lot_code:group.lot.lot_code,article_id:group.lot.article_id,unit:group.unit,
          received_quantity:amount(group.received),remaining_quantity:amount(remaining),consumed_quantity:amount(group.received-remaining),
          invoice_amount_ht:amount(allocated),booked_amount_ht:amount(group.booked),variance_ht:amount(delta),
          stock_variance_ht:amount(stock),consumed_variance_ht:amount(consumed),receipt_refs:group.receipts.map(r=>({
            receipt_line_id:r.receipt_line_id,movement_id:r.movement_id,entry_id:r.entry_id!,stock_sha256:r.source_sha256!,
            acquisition_sha256:r.acquisition_sha256!,entry_sha256:r.entry_sha256!}))});
        bookedTotal+=group.booked;stockDelta+=stock;consumedDelta+=consumed;
      }
      if(result.issues.length){result.lots=[];return result;}
      for(const value of [bookedTotal,target-bookedTotal,stockDelta,consumedDelta])number(amount(value),true);
      result.calculable=true;result.projection_ready=projectionReady;
      result.source_reliability=[...groups.values()].some(g=>g.reliability==='DECLARED')?'DECLARED':'VERIFIED';
      result.invoice_amount_ht=amount(target);result.booked_amount_ht=amount(bookedTotal);result.variance_ht=amount(target-bookedTotal);
      result.stock_variance_ht=amount(stockDelta);result.consumed_variance_ht=amount(consumedDelta);
      if(!projectionReady)fail('MATERIAL_PROJECTION_NOT_READY');
    } catch {result.lots=[];fail('MATERIAL_SOURCE_DECIMAL_OR_STRUCTURE_INVALID');}
    result.issues=[...new Set(result.issues)];return result;
  });
  return {id:invoice.id,row_version:invoice.row_version,method:MATERIAL_RECONCILIATION_METHOD,currency:invoice.currency,
    source_sha256:createHash('sha256').update(JSON.stringify({schema_version:1,method:MATERIAL_RECONCILIATION_METHOD,source})).digest('hex'),
    calculable:globalIssues.length===0&&lines.length>0&&lines.every(l=>l.calculable),
    projection_ready:lines.length>0&&lines.every(l=>l.calculable&&l.projection_ready),
    applied:false as const,requires_financial_confirmation:true as const,posting_available:false as const,
    header_source_sha256:header.source_sha256,issues:globalIssues,lines};
}
