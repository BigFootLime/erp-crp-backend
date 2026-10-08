import { createHash } from 'node:crypto';
import { z } from 'zod';

export const HEADER_ALLOCATION_METHOD = 'PROPORTIONAL_NET_V1' as const;
const money = z.string().regex(/^-?\d{1,16}(?:\.\d{1,2})?$/);
const factsSchema = z.object({
  invoice_id: z.string().uuid(), currency: z.string().regex(/^[A-Z]{3}$/),
  document_type: z.enum(['INVOICE','CREDIT_NOTE']), total_ht: money,
  match_version_id: z.string().uuid().nullable(), match_purchase_order_id: z.string().uuid().nullable(),
  match_outcome: z.string().nullable(), supplier_matches: z.boolean(),
  lines: z.array(z.object({ id: z.string().uuid(), position: z.number().int().positive(), net_ht: money,
    purchase_order_line_id: z.string().uuid().nullable() })).min(1).max(2000),
  artifacts:z.array(z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),
    document_id:z.string().uuid().nullable(),version_id:z.string().uuid().nullable(),
    scan_status:z.string(),archived_at:z.string().nullable()})).max(2000),
});
export type InvoiceHeaderFacts = z.infer<typeof factsSchema>;
export type InvoiceHeaderPlan = {
  method: typeof HEADER_ALLOCATION_METHOD; eligible: boolean; required: boolean;
  source_sha256: string | null; currency: string | null; total_ht: string | null;
  lines_ht: string | null; header_difference_ht: string | null; issues: string[];
  lines: Array<{ id: string; position: number; net_ht: string;
    purchase_order_line_id: string | null; header_amount_ht: string; total_ht: string }>;
};
function cents(value: string): bigint {
  const negative=value.startsWith('-'), [whole,fraction='']=value.replace(/^-/,'').split('.');
  const absolute=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return negative ? -absolute : absolute;
}
function amount(value: bigint): string {
  const absolute=value<0n?-value:value;
  return `${value<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}
function rounded(numerator: bigint, denominator: bigint): bigint {
  const quotient=numerator/denominator;
  return quotient+(numerator%denominator*2n>=denominator?1n:0n);
}

/** Exact cent allocation from fiscal evidence, never an HTTP amount input.
 * Cumulative rounded differences retain the residual and are independent of
 * database source order. Mixed-sign lines require a different owner policy. */
export function proposeInvoiceHeaderAllocation(input: unknown): InvoiceHeaderPlan {
  const invalid:InvoiceHeaderPlan={method:HEADER_ALLOCATION_METHOD,eligible:false,required:false,source_sha256:null,
    currency:null,total_ht:null,lines_ht:null,header_difference_ht:null,issues:['INVOICE_HEADER_FACTS_INVALID'],lines:[]};
  const parsed=factsSchema.safeParse(input);if(!parsed.success)return invalid;
  const raw=parsed.data;
  const facts:InvoiceHeaderFacts={...raw,invoice_id:raw.invoice_id.toLowerCase(),
    match_version_id:raw.match_version_id?.toLowerCase()??null,
    match_purchase_order_id:raw.match_purchase_order_id?.toLowerCase()??null,
    total_ht:amount(cents(raw.total_ht)),lines:raw.lines.map(line=>({...line,id:line.id.toLowerCase(),
      net_ht:amount(cents(line.net_ht)),purchase_order_line_id:line.purchase_order_line_id?.toLowerCase()??null}))
      .sort((left,right)=>left.position-right.position||left.id.localeCompare(right.id)),
    artifacts:raw.artifacts.map(artifact=>({...artifact,id:artifact.id.toLowerCase(),
      document_id:artifact.document_id?.toLowerCase()??null,version_id:artifact.version_id?.toLowerCase()??null}))
      .sort((left,right)=>left.id.localeCompare(right.id))};
  const total=cents(facts.total_ht), sum=facts.lines.reduce((value,line)=>value+cents(line.net_ht),0n), difference=total-sum;
  const issues:string[]=[];
  if(new Set(facts.lines.map(line=>line.id)).size!==facts.lines.length
    ||new Set(facts.lines.map(line=>line.position)).size!==facts.lines.length
    ||new Set(facts.artifacts.map(artifact=>artifact.id)).size!==facts.artifacts.length)issues.push('INVOICE_HEADER_LINES_DUPLICATED');
  const sign=total<0n||total===0n&&sum<0n?-1n:1n;
  if(facts.document_type==='INVOICE'&&total<0n || facts.lines.some(line=>cents(line.net_ht)*sign<0n))
    issues.push('INVOICE_HEADER_SIGNS_UNSUPPORTED');
  if(difference!==0n) {
    if(facts.match_outcome!=='MATCHED'||!facts.match_version_id||!facts.match_purchase_order_id||!facts.supplier_matches
      ||facts.lines.some(line=>!line.purchase_order_line_id))issues.push('INVOICE_HEADER_MATCH_INCOMPLETE');
    if(sum===0n)issues.push('INVOICE_HEADER_WEIGHTS_MISSING');
  }
  if(!facts.artifacts.length||facts.artifacts.some(artifact=>artifact.scan_status!=='CLEAN'
    ||!artifact.document_id||!artifact.version_id||!artifact.archived_at))issues.push('INVOICE_HEADER_ARCHIVE_INCOMPLETE');
  const plan:InvoiceHeaderPlan={method:HEADER_ALLOCATION_METHOD,eligible:issues.length===0,required:difference!==0n,
    source_sha256:createHash('sha256').update(JSON.stringify({schema_version:1,method:HEADER_ALLOCATION_METHOD,facts})).digest('hex'),
    currency:facts.currency,total_ht:amount(total),lines_ht:amount(sum),header_difference_ht:amount(difference),issues,lines:[]};
  if(!plan.eligible)return plan;
  const weightTotal=sum<0n?-sum:sum, absoluteDifference=difference<0n?-difference:difference;
  let before=0n;
  for(const line of facts.lines) {
    const net=cents(line.net_ht), weight=net<0n?-net:net;
    const header=difference===0n?0n:(rounded(absoluteDifference*(before+weight),weightTotal)
      -rounded(absoluteDifference*before,weightTotal))*(difference<0n?-1n:1n);
    before+=weight;
    if((net+header)*sign<0n) {plan.eligible=false;plan.issues.push('INVOICE_HEADER_DISCOUNT_EXCEEDS_LINE');plan.lines=[];return plan;}
    plan.lines.push({...line,header_amount_ht:amount(header),total_ht:amount(net+header)});
  }
  return plan;
}

export function invoiceHeaderAllocationProof(plan: InvoiceHeaderPlan) {
  if(!plan.eligible||!plan.source_sha256)throw new Error('INVOICE_HEADER_ALLOCATION_NOT_ELIGIBLE');
  return {schema_version:1,method:HEADER_ALLOCATION_METHOD,source_sha256:plan.source_sha256,
    currency:plan.currency,total_ht:plan.total_ht,header_difference_ht:plan.header_difference_ht,lines:plan.lines};
}

/** Recompute against the complete fiscal/match source, and require the exact
 * append-only approval proof. No historical missing proof is synthesized. */
export function readApprovedInvoiceHeaderAllocation(input: unknown,proof: unknown): Map<string,string> | null {
  const plan=proposeInvoiceHeaderAllocation(input);
  if(!plan.eligible||!proof||typeof proof!=='object'||Array.isArray(proof))return null;
  const row=proof as Record<string,unknown>,expected=invoiceHeaderAllocationProof(plan);
  if(row.schema_version!==expected.schema_version||row.method!==expected.method||row.source_sha256!==expected.source_sha256
    ||row.currency!==expected.currency||row.total_ht!==expected.total_ht||row.header_difference_ht!==expected.header_difference_ht
    ||!Array.isArray(row.lines)||row.lines.length!==expected.lines.length)return null;
  const stored=new Map<string,Record<string,unknown>>();
  for(const item of row.lines) {
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||stored.has(item.id))return null;
    stored.set(item.id,item as Record<string,unknown>);
  }
  if(expected.lines.some(line=>Object.entries(line).some(([key,value])=>stored.get(line.id)?.[key]!==value)))return null;
  return new Map(expected.lines.map(line=>[line.id,line.total_ht]));
}
export function readApprovedInvoiceHeaderLine(input: unknown,proof: unknown,lineId: string): string | null {
  return readApprovedInvoiceHeaderAllocation(input,proof)?.get(lineId.toLowerCase())??null;
}
