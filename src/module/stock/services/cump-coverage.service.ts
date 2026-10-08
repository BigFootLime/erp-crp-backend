import { readCumpArticleCoverage } from '../repository/cump-coverage.repository';
import { resolveCumpArticleCoverage } from '../domain/cump-coverage';
import { HttpError } from '../../../utils/httpError';

export async function getCumpArticleCoverage(articleId:string,includeCosts:boolean) {
  const snapshot=await readCumpArticleCoverage(articleId);
  if(!snapshot)throw new HttpError(404,'STOCK_ARTICLE_NOT_FOUND','Article de stock introuvable.');
  const result=resolveCumpArticleCoverage(snapshot);
  return { article_id:snapshot.article_id,code:snapshot.code,designation:snapshot.designation,observed_at:snapshot.observed_at,
    projector_mode:snapshot.mode,formula_version:snapshot.formula_version,prices_visible:includeCosts,
    issues:result.issues,positions:result.positions.map(p=>includeCosts ? p : {
      ...p,value:null,unit_cost:null,reliability:'UNKNOWN' as const,source_ref:null }) };
}
