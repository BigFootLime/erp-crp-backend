import { reconcileCumpOpenings,type CumpOpeningRow } from './cump-opening';
import { CUMP_FORMULA_VERSION,normalizeCumpScope,type CumpScope,type CumpReliability } from './cump-valuation';
import { CUMP_DECIMAL_SCALE,parseCumpDecimal as decimal,formatCumpDecimal as text,roundCumpRatio } from './cump-decimal';

export type CumpProjectedPosition={ article_id:string;owner_key:CumpScope['owner'];stock_unit:string;currency:string;
  quantity:string;value:string|null;reliability:CumpReliability;source_ref:string|null;latest_sequence:string;
  latest_entry_id:string;source_valid:boolean };
export type CumpCoverageSnapshot={ article_id:string;code:string;designation:string;observed_at:string;
  mode:'PREPARED'|'ACTIVE';initialized:boolean;reporting_currency:string;formula_version:string;last_sequence:string;
  pending_movements:string;blocked:boolean;capture_missing:boolean;physical:CumpOpeningRow[];projected:CumpProjectedPosition[] };
export type CumpCoverageStatus='PREPARED'|'PENDING'|'MISMATCH'|'UNKNOWN'|'AVAILABLE'|'CLIENT_OWNED';
export type CumpCoveredPosition={ scope:CumpScope;physical_quantity:string|null;projected_quantity:string|null;
  status:CumpCoverageStatus;value:string|null;unit_cost:string|null;reliability:CumpReliability;
  source_ref:string|null;issues:string[] };

/** A known stored amount is insufficient. Reconcile article quantities and
 * verify projection completeness before exposing current financial value. */
export function resolveCumpArticleCoverage(snapshot:CumpCoverageSnapshot): { positions:CumpCoveredPosition[];issues:string[] } {
  if(snapshot.physical.length>10000 || snapshot.projected.length>1000)
    return { positions:[],issues:['STOCK_COVERAGE_WINDOW_TOO_DENSE'] };
  if(snapshot.physical.some(p=>p.article_id!==snapshot.article_id))
    return { positions:[],issues:['PHYSICAL_STOCK_SCOPE_INVALID'] };
  const physical=reconcileCumpOpenings(snapshot.physical,snapshot.reporting_currency);
  const physicalUnknown=physical.blockedArticleIds.includes(snapshot.article_id);
  const issues=physical.issues.map(i=>i.code);
  if(physical.blockedArticleIds.length) issues.push('PHYSICAL_STOCK_UNRESOLVED');
  if(snapshot.blocked) issues.push('STOCK_EVIDENCE_UNRESOLVED');
  if(snapshot.capture_missing) issues.push('STOCK_POSTING_CAPTURE_MISSING');
  const states=new Map<string,{scope:CumpScope;quantity:string}>();
  const projections=new Map<string,CumpProjectedPosition>();
  const key=(scope:CumpScope)=>JSON.stringify(scope);
  for(const p of physical.openings)states.set(key(p.state.scope),p.state);
  for(const p of snapshot.projected) {
    try {
      const scope=normalizeCumpScope({articleId:p.article_id,owner:p.owner_key,unit:p.stock_unit,currency:p.currency}),k=key(scope);
      if(scope.articleId!==snapshot.article_id || scope.currency!==snapshot.reporting_currency || projections.has(k)) {
        issues.push('PROJECTED_SCOPE_INVALID'); continue;
      }
      projections.set(k,p); if(!states.has(k)) states.set(k,{scope,quantity:'0'});
    } catch { issues.push('PROJECTED_SCOPE_INVALID'); }
  }
  const general=[...new Set(issues)];
  const positions:CumpCoveredPosition[]=[];
  for(const [k,p] of states) {
    const projection=projections.get(k);
    let status:CumpCoverageStatus='UNKNOWN',value:string|null=null,unitCost:string|null=null;
    let reliability:CumpReliability='UNKNOWN',sourceRef:string|null=null,projectedQuantity:string|null=null;
    const reasons=[...general];
    try {
      const actual=decimal(p.quantity,true),projected=projection ? decimal(projection.quantity,true) : null;
      projectedQuantity=projected===null ? null : text(projected);
      if(snapshot.mode!=='ACTIVE' || !snapshot.initialized) { status='PREPARED'; reasons.push('CUMP_PROJECTION_NOT_ACTIVE'); }
      else if(snapshot.formula_version!==CUMP_FORMULA_VERSION) reasons.push('CUMP_FORMULA_VERSION_UNSUPPORTED');
      else if(decimal(snapshot.pending_movements)>0n) { status='PENDING';reasons.push('CUMP_PROJECTION_PENDING'); }
      else if(reasons.length) status='UNKNOWN';
      else if(!projection) reasons.push('CUMP_SCOPE_BALANCE_MISSING');
      else if(!projection.source_valid || !projection.source_ref || BigInt(projection.latest_sequence)>BigInt(snapshot.last_sequence))
        reasons.push('CUMP_BALANCE_PROOF_INVALID');
      else if(projected!==actual) { status='MISMATCH';reasons.push('PHYSICAL_PROJECTED_QUANTITY_MISMATCH'); }
      else if(actual<0n) reasons.push('NEGATIVE_STOCK');
      else if(p.scope.owner!=='COMPANY') { status='CLIENT_OWNED';reasons.push('CLIENT_OWNED_STOCK_EXCLUDED_FROM_COMPANY_VALUE'); }
      else if(projection.value===null || !['VERIFIED','DECLARED'].includes(projection.reliability)) reasons.push('STOCK_VALUE_UNKNOWN');
      else {
        const amount=decimal(projection.value);
        if(actual===0n && amount!==0n) reasons.push('CUMP_BALANCE_VALUE_INVALID');
        else {
          value=text(amount);unitCost=actual===0n ? null : text(roundCumpRatio(amount*CUMP_DECIMAL_SCALE,actual));
          if(unitCost!==null)decimal(unitCost);
          reliability=projection.reliability;sourceRef=projection.source_ref;status='AVAILABLE';
        }
      }
    } catch { status='UNKNOWN';value=null;unitCost=null;reasons.push('CUMP_BALANCE_PRECISION_INVALID'); }
    // A malformed batch must not leave a plausible partial quantity on screen.
    positions.push({ scope:p.scope,physical_quantity:physicalUnknown ? null : p.quantity,projected_quantity:projectedQuantity,status,
      value,unit_cost:unitCost,reliability,source_ref:sourceRef,issues:[...new Set(reasons)] });
  }
  return { positions,issues:general };
}
