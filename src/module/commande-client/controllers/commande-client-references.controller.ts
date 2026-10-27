import type { RequestHandler } from "express";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { companyRuntimeService } from "../../entreprises/runtime/company-runtime.service";
import { parseUuidRouteParam } from "../../../utils/routeParams";
import { crmClientIdSchema } from "../../client/validators/client-crm.validators";
import {
  getCommandeClientReference as getCommandeClientReferenceService,
  getCommandeClientContract as getCommandeClientContractService,
  getCommandeClientContractForecast as getCommandeClientContractForecastService,
  getCommandeReferenceArticle as getCommandeReferenceArticleService,
  getCommandeReferencePiece as getCommandeReferencePieceService,
  listCommandeClientContacts as listCommandeClientContactsService,
  listCommandeClientContracts as listCommandeClientContractsService,
  listCommandeClientContractCalls as listCommandeClientContractCallsService,
  listCommandeClientContractForecasts as listCommandeClientContractForecastsService,
  listCommandeClientReferences as listCommandeClientReferencesService,
  listCommandeReferenceArticleVersions as listCommandeReferenceArticleVersionsService,
  listCommandeReferenceArticles as listCommandeReferenceArticlesService,
  listCommandeReferenceEmplacements as listCommandeReferenceEmplacementsService,
  listCommandeReferenceMagasins as listCommandeReferenceMagasinsService,
  listCommandeReferencePieceVersions as listCommandeReferencePieceVersionsService,
} from "../services/commande-client-references.service";

function respond(operation: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => { try { res.json(await operation(req)); } catch (error) { next(error); } };
}
const clientId = (req: Parameters<RequestHandler>[0]) => crmClientIdSchema.parse(req.params.clientId);

export const listCommandeReferenceClients = respond((req) => listCommandeClientReferencesService(req.query));
export const getCommandeReferenceClient = respond((req) => getCommandeClientReferenceService(clientId(req)));
export const listCommandeReferenceClientContacts = respond((req) => listCommandeClientContactsService(clientId(req)));
export const listCommandeReferenceClientContracts = respond((req) => listCommandeClientContractsService(clientId(req), req.query));
export const getCommandeReferenceClientContract = respond((req) => getCommandeClientContractService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const listCommandeReferenceClientContractCalls = respond((req) => listCommandeClientContractCallsService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const listCommandeReferenceClientContractForecasts = respond((req) => listCommandeClientContractForecastsService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const getCommandeReferenceClientContractForecast = respond((req) => getCommandeClientContractForecastService(clientId(req), parseUuidRouteParam(req.params, "contractId"), parseUuidRouteParam(req.params, "forecastId"), req.query));
export const getCommandeReferencePiece = respond((req) => getCommandeReferencePieceService(parseUuidRouteParam(req.params, "pieceId")));
export const listCommandeReferencePieceVersions = respond((req) => listCommandeReferencePieceVersionsService(parseUuidRouteParam(req.params, "pieceId")));
export const listCommandeReferenceArticleVersions = respond((req) => listCommandeReferenceArticleVersionsService(parseUuidRouteParam(req.params, "articleId"), req.query));
async function commercialArticleReferences(req: Parameters<RequestHandler>[0], id?:string) {
  if(!req.user) throw new HttpError(401,"UNAUTHORIZED","Authentication required");
  const access=await companyRuntimeService.access(req.user); if(!access||access.context.profile!=="COMMERCIAL") return null;
  const q=typeof req.query.q==="string"?req.query.q.trim():"";
  const rows=await db.query<Record<string,unknown>>(`SELECT c.id::text AS intercompany_catalogue_mapping_id,c.local_article_id::text AS id,a.code,c.designation,c.unit AS unite,c.buyer_sale_unit_price::float8 AS sale_price_reference,c.buyer_sale_vat_rate::float8 AS sale_vat_rate,c.currency,c.supplier_catalogue_mapping_id::text,c.supplier_mapping_version,c.variant_code,c.options_snapshot FROM public.intercompany_commercial_catalogue c JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id JOIN public.articles a ON a.id=c.local_article_id WHERE r.buyer_company_id=$1::uuid AND r.local_role='BUYER' AND c.local_role='BUYER' AND c.active AND ($2='' OR c.designation ILIKE '%'||$2||'%') ${id?"AND c.local_article_id=$3::uuid":""} ORDER BY c.designation LIMIT 100`,id?[access.context.company_id,q,id]:[access.context.company_id,q]);
  const items=rows.rows.map(row=>({id:String(row.id),code:String(row.code),designation:String(row.designation),unite:String(row.unite),sale_price_reference:Number(row.sale_price_reference),sale_vat_rate:Number(row.sale_vat_rate),sale_price_currency:String(row.currency),intercompany_catalogue_mapping_id:String(row.intercompany_catalogue_mapping_id),supplier_catalogue_mapping_id:String(row.supplier_catalogue_mapping_id),supplier_mapping_version:Number(row.supplier_mapping_version),variant_code:String(row.variant_code??""),options_snapshot:row.options_snapshot??{},commande_client_eligible:true}));
  return id?(items[0]??null):{items,total:items.length};
}
export const listCommandeReferenceArticles = respond(async(req) => (await commercialArticleReferences(req)) ?? listCommandeReferenceArticlesService(req.query));
export const getCommandeReferenceArticle = respond(async(req) => {const id=parseUuidRouteParam(req.params,"articleId");const commercial=await commercialArticleReferences(req,id);return commercial??getCommandeReferenceArticleService(id);});
export const listCommandeReferenceMagasins = respond((req) => listCommandeReferenceMagasinsService(req.query));
export const listCommandeReferenceEmplacements = respond((req) => listCommandeReferenceEmplacementsService(req.query));
