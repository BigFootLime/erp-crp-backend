import type { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { buildContentDisposition } from "../../../shared/uploads/secure-download";
import { buildAuditContext } from "../../project-office/controllers/project-office.controller";
import { listWorkshopDispatchJobs } from "../repository/workshop-dispatch.repository";
import { claimWorkshopDispatchJob, printWorkshopDispatchJob, acknowledgeWorkshopDispatchJob } from "../services/workshop-dispatch.service";
import { printResponseContext, setWorkshopPrintHeaders } from "./workshop-print-response";
const device = z.object({ deviceId: z.string().guid() }).strict();
const params = z.object({ jobId: z.string().guid() });
const receipt = device.extend({ intentId: z.string().guid(), outcome: z.enum(["SPOOLED", "FAILED", "UNCERTAIN"]) });
function actor(req: Request) {
  if (!req.user || !Number.isSafeInteger(req.user.id)) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { userId: req.user.id, username: req.user.username ?? `#${req.user.id}`, role: req.user.role ?? null };
}
export const listDispatch = asyncHandler(async (req: Request, res: Response) => {
  const { deviceId } = device.parse(req.query);
  res.json({ jobs: await listWorkshopDispatchJobs(actor(req).userId, deviceId) });
});
export const claimDispatch = asyncHandler(async (req: Request, res: Response) => {
  const { jobId } = params.parse(req.params), { deviceId } = device.parse(req.body);
  res.json(await claimWorkshopDispatchJob(jobId, deviceId, actor(req), buildAuditContext(req)));
});
export const printDispatch = asyncHandler(async (req: Request, res: Response) => {
  const { jobId } = params.parse(req.params), { deviceId } = device.parse(req.body);
  const database = await printResponseContext();
  const result = await printWorkshopDispatchJob(jobId, deviceId, actor(req), buildAuditContext(req));
  setWorkshopPrintHeaders(res, database, result.intent.actor_id, result.intent.id, result.intent.copy_mark, result.pdf);
  res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Length", String(result.pdf.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", buildContentDisposition(`DOSSIER-${jobId}.pdf`, false));
  res.end(result.pdf);
});
export const acknowledgeDispatch = asyncHandler(async (req: Request, res: Response) => {
  const { jobId } = params.parse(req.params), { deviceId, intentId, outcome } = receipt.parse(req.body);
  res.json(await acknowledgeWorkshopDispatchJob(jobId, deviceId, intentId, outcome, actor(req).userId, buildAuditContext(req)));
});
