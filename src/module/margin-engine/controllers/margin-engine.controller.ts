import type { RequestHandler } from "express";
import { buildAuditContext } from './margin-audit-context';
import type { MarginScopeType } from "../domain/margin-engine";
import { openingBasisBody,openingBasisParams } from '../../stock/validators/cump-opening-basis.validators';
import { declareOpeningBasis,getOpeningBasis,getOpeningBasisCandidate } from '../../stock/services/cump-opening-basis.service';
import { manufacturingBasisBody, manufacturingBasisCandidateParams,
  manufacturingBasisParams } from '../validators/manufacturing-cost-basis.validators';
import {
  createMarginInputSchema,
  createRateVersionSchema,
  marginReadQuerySchema,
  marginScopeParamsSchema,
  marginSnapshotBodySchema,
  marginSnapshotListQuerySchema,
} from "../validators/margin-engine.validators";
import {
  svcCreateMarginInput,
  svcCreateMarginSnapshot,
  svcCreateRateVersion,
  svcExportMargin,
  svcGetMargin,
  svcListRateVersions,
  svcListMarginSnapshots,
  svcDeclareManufacturingBasis,
  svcManufacturingBasisCandidate,
  svcReadManufacturingBasis,
} from "../services/margin-engine.service";

const SCOPE_MAP: Record<"devis-line" | "devis" | "affaire" | "of", MarginScopeType> = {
  "devis-line": "DEVIS_LINE",
  devis: "DEVIS",
  affaire: "AFFAIRE",
  of: "OF",
};

export const getMargin: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginReadQuerySchema.parse(req.query);
    res.json(await svcGetMargin(SCOPE_MAP[params.scopeType], params.scopeRef, query.as_of));
  } catch (error) { next(error); }
};

export const exportMargin: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginReadQuerySchema.parse(req.query);
    const csv = await svcExportMargin(SCOPE_MAP[params.scopeType], params.scopeRef, query.as_of);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="margin-${params.scopeType}-${params.scopeRef}.csv"`);
    res.send(csv);
  } catch (error) { next(error); }
};

export const createMarginInput: RequestHandler = async (req, res, next) => {
  try {
    const input = createMarginInputSchema.parse(req.body);
    const created = await svcCreateMarginInput(input, buildAuditContext(req));
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const createRateVersion: RequestHandler = async (req, res, next) => {
  try {
    const input = createRateVersionSchema.parse(req.body);
    const created = await svcCreateRateVersion(input, buildAuditContext(req));
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const listRateVersions: RequestHandler = async (req, res, next) => {
  try {
    const query = marginReadQuerySchema.parse(req.query);
    res.json({ items: await svcListRateVersions(query.as_of) });
  } catch (error) { next(error); }
};

export const createMarginSnapshot: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const body = marginSnapshotBodySchema.parse(req.body);
    const query = marginReadQuerySchema.parse(req.query);
    const created = await svcCreateMarginSnapshot(
      SCOPE_MAP[params.scopeType], params.scopeRef, body.basis, query.as_of, buildAuditContext(req),
    );
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const listMarginSnapshots: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginSnapshotListQuerySchema.parse(req.query);
    const items = await svcListMarginSnapshots(SCOPE_MAP[params.scopeType], params.scopeRef, query);
    res.json({ items });
  } catch (error) { next(error); }
};

export const getManufacturingBasisCandidate: RequestHandler = async (req,res,next) => {
  try {
    const {ofId,snapshotId}=manufacturingBasisCandidateParams.parse(req.params);
    res.setHeader('Cache-Control','no-store');
    res.json(await svcManufacturingBasisCandidate(ofId,snapshotId));
  } catch(error) {next(error);}
};
export const getManufacturingBasis: RequestHandler = async (req,res,next) => {
  try {
    const {ofId}=manufacturingBasisParams.parse(req.params);
    res.setHeader('Cache-Control','no-store');res.json(await svcReadManufacturingBasis(ofId));
  } catch(error) {next(error);}
};
export const declareManufacturingBasis: RequestHandler = async (req,res,next) => {
  try {
    const {ofId}=manufacturingBasisParams.parse(req.params);
    const input=manufacturingBasisBody.parse(req.body);
    const result=await svcDeclareManufacturingBasis(ofId,input,buildAuditContext(req));
    res.setHeader('Cache-Control','no-store');res.status(result.replayed?200:201).json(result);
  } catch(error) {next(error);}
};

export const readOpeningValueCandidate:RequestHandler=async(req,res,next)=>{
  try {
    const {articleId,unit}=openingBasisParams.parse(req.params);
    res.setHeader('Cache-Control','no-store');res.json(await getOpeningBasisCandidate(articleId,unit));
  } catch(error){next(error);}
};
export const readOpeningValueBasis:RequestHandler=async(req,res,next)=>{
  try {
    const {articleId,unit}=openingBasisParams.parse(req.params);
    res.setHeader('Cache-Control','no-store');res.json(await getOpeningBasis(articleId,unit));
  } catch(error){next(error);}
};
export const declareOpeningValueBasis:RequestHandler=async(req,res,next)=>{
  try {
    const {articleId,unit}=openingBasisParams.parse(req.params);
    const input=openingBasisBody.parse(req.body);
    const result=await declareOpeningBasis(articleId,unit,input,buildAuditContext(req));
    res.setHeader('Cache-Control','no-store');res.status(result.replayed?200:201).json(result);
  } catch(error){next(error);}
};
