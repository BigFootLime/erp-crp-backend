import type { RequestHandler } from 'express';
import { idParamSchema } from '../validators/stock.validators';
import { canViewArticleCosts } from '../stock-article.permissions';
import { getCumpArticleCoverage } from '../services/cump-coverage.service';

export const getStockArticleValuation:RequestHandler=async(req,res,next)=>{
  try {
    const {params}=idParamSchema.parse({params:req.params});
    res.setHeader('Cache-Control','no-store');
    res.json(await getCumpArticleCoverage(params.id,canViewArticleCosts(req.user?.role)));
  } catch(error){next(error);}
};
