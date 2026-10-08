import type { MarginAuditContext } from '../../margin-engine/repository/margin-engine.repository';
import type { DeclareOpeningBasis } from '../validators/cump-opening-basis.validators';
import { repoDeclareOpeningBasis,repoOpeningBasisCandidate,repoReadOpeningBasis } from '../repository/cump-opening-basis.repository';

export const getOpeningBasisCandidate=(articleId:string,unit:string)=>repoOpeningBasisCandidate(articleId,unit);
export const getOpeningBasis=(articleId:string,unit:string)=>repoReadOpeningBasis(articleId,unit);
export const declareOpeningBasis=(articleId:string,unit:string,input:DeclareOpeningBasis,audit:MarginAuditContext)=>
  repoDeclareOpeningBasis(articleId,unit,input,audit);
