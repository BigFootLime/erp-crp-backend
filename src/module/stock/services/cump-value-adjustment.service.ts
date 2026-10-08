import type { MarginAuditContext } from '../../margin-engine/repository/margin-engine.repository';
import type { DeclareValueAdjustment } from '../validators/cump-value-adjustment.validators';
import { repoValueAdjustmentCandidate,repoListValueAdjustments,repoDeclareValueAdjustment } from '../repository/cump-value-adjustment.repository';
export const svcValueAdjustmentCandidate=(article:string,unit:string)=>repoValueAdjustmentCandidate(article,unit);
export const svcListValueAdjustments=(article:string,unit:string)=>repoListValueAdjustments(article,unit);
export const svcDeclareValueAdjustment=(article:string,unit:string,input:DeclareValueAdjustment,audit:MarginAuditContext)=>repoDeclareValueAdjustment(article,unit,input,audit);
