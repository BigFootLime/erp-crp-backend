import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { buildAuditContext } from "./production.controller";
import { materialDebitSchema } from "../validators/of-material.validators";
import { stationDossierParamsSchema } from "../validators/station.validators";
import {
  readStationCutting,
  debitStationCutting,
  scanStationCutting,
} from "../services/station-cutting.service";
function station(req: Request) {
  if (!req.station)
    throw new HttpError(
      401,
      "STATION_SESSION_REQUIRED",
      "Identifiez-vous sur le poste.",
    );
  return req.station;
}
const scan = z
  .object({
    code: z.string().trim().min(1).max(256),
    eventId: z.string().uuid(),
  })
  .strict();
export const readCutting = asyncHandler(async (req, res) => {
  const p = stationDossierParamsSchema.parse(req.params);
  res.json(await readStationCutting(station(req), p.ofId, p.operationId));
});
export const debitCutting = asyncHandler(async (req, res) => {
  const s = station(req),
    p = stationDossierParamsSchema.parse(req.params),
    body = materialDebitSchema.parse(req.body);
  if (body.operationId !== p.operationId)
    throw new HttpError(
      422,
      "STATION_CUTTING_OPERATION_CONFLICT",
      "L’opération du débit doit correspondre au dossier ouvert.",
    );
  res.json(
    await debitStationCutting(s, p.ofId, body, {
      ...buildAuditContext(req),
      user_id: s.user.id,
      user_role: s.user.role,
    }),
  );
});
export const scanCutting = asyncHandler(async (req, res) => {
  const p = stationDossierParamsSchema.parse(req.params),
    body = scan.parse(req.body);
  res.json(
    await scanStationCutting(
      station(req),
      p.ofId,
      p.operationId,
      body.code,
      body.eventId,
    ),
  );
});
