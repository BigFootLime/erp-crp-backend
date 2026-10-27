import type { RequestHandler } from "express";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { companyRuntimeService } from "../runtime/company-runtime.service";
import { commercialCatalogueCreateSchema, commercialCataloguePatchSchema } from "./commercial-catalogue";
import { repoCreateCommercialCatalogueTx, repoListCommercialCatalogueTx, repoPatchCommercialCatalogueTx } from "./commercial-catalogue.repository";

async function commercialContext(req: Parameters<RequestHandler>[0]) {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  const access = await companyRuntimeService.access(req.user);
  if (!access || access.context.profile !== "COMMERCIAL" || !access.context.module_keys.includes("fournisseurs"))
    throw new HttpError(403, "INTERCOMPANY_COMMERCIAL_SCOPE_DENIED", "Le catalogue interentreprises exige une entreprise commerciale avec le module fournisseurs.");
  return access.context;
}
function audit(req: Parameters<RequestHandler>[0]) {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return { user_id: req.user.id, ip: req.ip ?? null, user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null, device_type: null, os: null, browser: null, path: req.originalUrl ?? null, page_key: "intercompany-catalogue", client_session_id: null };
}
export const listCommercialCatalogue: RequestHandler = async (req, res, next) => { try { const context = await commercialContext(req); res.json(await repoListCommercialCatalogueTx(db, context.company_id)); } catch (error) { next(error); } };
export const createCommercialCatalogue: RequestHandler = async (req, res, next) => { const tx = await db.connect(); try { const context = await commercialContext(req); const input = commercialCatalogueCreateSchema.parse(req.body); await tx.query("BEGIN"); const out = await repoCreateCommercialCatalogueTx(tx, context.company_id, input, audit(req)); await tx.query("COMMIT"); res.status(201).json(out); } catch (error) { await tx.query("ROLLBACK"); next(error); } finally { tx.release(); } };
export const patchCommercialCatalogue: RequestHandler = async (req, res, next) => { const tx = await db.connect(); try { const context = await commercialContext(req); const id = String(req.params.id ?? ""); const input = commercialCataloguePatchSchema.parse(req.body); await tx.query("BEGIN"); const out = await repoPatchCommercialCatalogueTx(tx, context.company_id, id, input, req.user!.id); await tx.query("COMMIT"); res.json(out); } catch (error) { await tx.query("ROLLBACK"); next(error); } finally { tx.release(); } };
