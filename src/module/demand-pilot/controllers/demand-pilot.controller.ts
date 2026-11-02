import { qualifyDemandPreview } from "../services/demand-preview.service";
import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import {
  decisionSchema,
  idempotencyKeySchema,
  importSchema,
  listSchema,
  portalResponseSchema,
  previewSchema,
  rawImportSchema,
} from "../validators/demand-pilot.validators";
import * as service from "../services/demand-pilot.service";
import {
  parseDemandImport,
  parseDemandImportFile,
} from "../../demand-import/demand-import.adapter";
import { bindFirmDemand } from "../services/demand-pilot-firm-binding.service";
import { z } from "zod";

const user = (req: Parameters<RequestHandler>[0]) => {
  if (typeof req.user?.id !== "number")
    throw new HttpError(401, "UNAUTHORIZED", "Connexion requise.");
  return req.user.id;
};
const key = (req: Parameters<RequestHandler>[0]) => {
  const parsed = idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
  if (!parsed.success)
    throw new HttpError(
      400,
      "DEMAND_PILOT_IDEMPOTENCY_REQUIRED",
      "Un en-tête Idempotency-Key UUID est requis.",
    );
  return parsed.data;
};
const portal = (req: Parameters<RequestHandler>[0]) => {
  if (!req.portalIdentity)
    throw new HttpError(
      401,
      "CLIENT_PORTAL_SESSION_REQUIRED",
      "Session portail requise.",
    );
  return req.portalIdentity;
};
/** Keep private scenario notes, ERP bindings and other customers' planning information inside CRP. */
function portalSafe<T extends Record<string, unknown>>(record: T) {
  const keys = [
    "id",
    "external_site",
    "external_order_key",
    "external_line_key",
    "external_schedule_key",
    "source_version",
    "source_as_of",
    "kind",
    "quantity",
    "unit",
    "quantity_basis",
    "need_date",
    "article_code",
    "customer_reference",
    "comment",
    "revision_no",
    "diff_type",
    "status",
    "created_at",
    "decided_at",
    "accepted_need_date",
    "counter_offer",
    "customer_proposed_date",
    "customer_message",
  ];
  return Object.fromEntries(
    keys.filter((key) => key in record).map((key) => [key, record[key]]),
  );
}
export const list: RequestHandler = async (req, res, next) => {
  try {
    const q = listSchema.parse(req.query);
    if (!q.client_id)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    res.json(
      await service.listDemand({
        clientId: q.client_id,
        status: q.status,
        page: q.page,
        pageSize: q.page_size,
      }),
    );
  } catch (e) {
    next(e);
  }
};
export const get: RequestHandler = async (req, res, next) => {
  try {
    const clientId = String(req.query.client_id ?? "").trim();
    if (!clientId)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    res.json({
      data: await service.getDemand(clientId, String(req.params.id)),
    });
  } catch (e) {
    next(e);
  }
};
function parsedImport(body: unknown) {
  const raw = rawImportSchema.safeParse(body);
  if (raw.success) {
    const parsed = parseDemandImport({
      source: raw.data.source,
      rows: raw.data.rows,
      first_data_row_number: raw.data.first_data_row_number,
    });
    if (parsed.summary.invalid)
      throw new HttpError(
        422,
        "DEMAND_PILOT_IMPORT_INVALID",
        "L’import contient des lignes invalides.",
        parsed,
      );
    return {
      ...raw.data,
      rows: parsed.rows.map((row) => ({
        ...row,
        quantity_basis: row.quantity_basis ?? "TOTAL",
      })),
    };
  }
  return importSchema.parse(body);
}
async function preview(
  req: Parameters<RequestHandler>[0],
  clientId: string,
  portalAccountId?: string,
) {
  const body = previewSchema.parse(req.body);
  if (!req.file)
    throw new HttpError(
      400,
      "DEMAND_PILOT_IMPORT_FILE_REQUIRED",
      "Sélectionnez un fichier CSV ou XLSX.",
    );
  const parsed = parseDemandImportFile({
    source: body.source,
    file: req.file,
    sheet_name: body.sheet_name,
    defaults: {
      external_site: body.external_site,
      source_version: body.source_version,
      source_as_of: body.source_as_of,
    },
  });
  return {
    scope: {
      external_site: body.external_site,
      source_version: body.source_version,
      source_as_of: body.source_as_of,
    },
    ...(await qualifyDemandPreview(
      clientId,
      body.external_site,
      parsed,
      portalAccountId,
    )),
  };
}
export const importInternal: RequestHandler = async (req, res, next) => {
  try {
    const body = parsedImport(req.body);
    if (!body.client_id)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    const result = await service.importDemand({
      clientId: body.client_id,
      rows: body.rows,
      sourceFileName: body.source_file_name,
      completeSnapshot: body.complete_snapshot,
      actor: { userId: user(req) },
      idempotencyKey: key(req),
    });
    res
      .status(result.replayed ? 200 : 201)
      .setHeader("Idempotency-Replayed", String(result.replayed))
      .json(result);
  } catch (e) {
    next(e);
  }
};
export const manual: RequestHandler = async (req, res, next) =>
  importInternal(req, res, next);
export const previewInternal: RequestHandler = async (req, res, next) => {
  try {
    const body = previewSchema.parse(req.body);
    if (!body.client_id)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    res.json(await preview(req, body.client_id));
  } catch (e) {
    next(e);
  }
};
export const decide: RequestHandler = async (req, res, next) => {
  try {
    const body = decisionSchema.parse(req.body),
      clientId = String(req.query.client_id ?? "").trim();
    if (!clientId)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    const result = await service.decideDemand({
      clientId,
      id: String(req.params.id),
      expectedVersion: body.expected_version,
      action: body.action,
      reason: body.reason,
      scenarioCode: body.scenario_code,
      confirmedNeedDate: body.confirmed_need_date,
      plannerEvidence: body.planner_evidence,
      actor: { userId: user(req) },
      idempotencyKey: key(req),
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
};
export const bindFirm: RequestHandler = async (req, res, next) => {
  try {
    const clientId = String(req.query.client_id ?? "").trim();
    if (!clientId)
      throw new HttpError(
        400,
        "DEMAND_PILOT_CLIENT_REQUIRED",
        "client_id requis.",
      );
    const body = z
      .object({ promise_root_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json({
        data: await bindFirmDemand({
          revisionId: String(req.params.id),
          clientId,
          promiseRootId: body.promise_root_id,
          actorId: user(req),
        }),
      });
  } catch (e) {
    next(e);
  }
};
export const listPortal: RequestHandler = async (req, res, next) => {
  try {
    const q = listSchema.parse(req.query),
      identity = portal(req),
      result = await service.listDemand({
        clientId: identity.clientId,
        status: q.status,
        page: q.page,
        pageSize: q.page_size,
        portalAccountId: identity.accountId,
      });
    res.json({ ...result, data: result.data.map(portalSafe) });
  } catch (e) {
    next(e);
  }
};
export const importPortal: RequestHandler = async (req, res, next) => {
  try {
    const body = parsedImport(req.body),
      identity = portal(req);
    if (body.client_id && body.client_id !== identity.clientId)
      throw new HttpError(
        403,
        "DEMAND_PILOT_PORTAL_BINDING",
        "Le client soumis ne correspond pas au compte portail.",
      );
    const result = await service.importDemand({
      clientId: identity.clientId,
      rows: body.rows,
      sourceFileName: body.source_file_name,
      completeSnapshot: body.complete_snapshot,
      actor: { portalAccountId: identity.accountId },
      idempotencyKey: key(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (e) {
    next(e);
  }
};
export const previewPortal: RequestHandler = async (req, res, next) => {
  try {
    const body = previewSchema.parse(req.body),
      identity = portal(req);
    if (body.client_id && body.client_id !== identity.clientId)
      throw new HttpError(
        403,
        "DEMAND_PILOT_PORTAL_BINDING",
        "Le client soumis ne correspond pas au compte portail.",
      );
    res.json(await preview(req, identity.clientId, identity.accountId));
  } catch (e) {
    next(e);
  }
};
export const getPortal: RequestHandler = async (req, res, next) => {
  try {
    const identity = portal(req);
    res.json({
      data: portalSafe(
        await service.getDemand(
          identity.clientId,
          String(req.params.id),
          identity.accountId,
        ),
      ),
    });
  } catch (e) {
    next(e);
  }
};
export const responsePortal: RequestHandler = async (req, res, next) => {
  try {
    const body = portalResponseSchema.parse(req.body),
      identity = portal(req);
    await service.getDemand(
      identity.clientId,
      String(req.params.id),
      identity.accountId,
    );
    const result = await service.respondPortalDemand({
      clientId: identity.clientId,
      id: String(req.params.id),
      expectedVersion: body.expected_version,
      response: body.response,
      counterId: body.counter_id,
      proposedNeedDate: body.proposed_need_date,
      comment: body.comment,
      actor: { portalAccountId: identity.accountId },
      idempotencyKey: key(req),
    });
    res.json({ ...result, data: portalSafe(result.data) });
  } catch (e) {
    next(e);
  }
};
