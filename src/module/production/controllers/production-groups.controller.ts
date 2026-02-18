import type { Request } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import {
  createProductionGroupBodySchema,
  linkProductionGroupBodySchema,
  listProductionGroupsQuerySchema,
  productionGroupIdParamSchema,
  unlinkProductionGroupBodySchema,
  updateProductionGroupBodySchema,
} from "../validators/production-groups.validators";
import {
  svcCreateProductionGroup,
  svcGetProductionGroup,
  svcLinkProductionGroup,
  svcListProductionGroups,
  svcUnlinkProductionGroup,
  svcUpdateProductionGroup,
} from "../services/production-groups.service";
import type { AuditContext } from "../repository/production.repository";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const listProductionGroups = asyncHandler(async (req, res) => {
  const query = listProductionGroupsQuerySchema.parse(req.query);
  const out = await svcListProductionGroups(query);
  res.json(out);
});

export const getProductionGroup = asyncHandler(async (req, res) => {
  const { id } = productionGroupIdParamSchema.parse(req.params);
  const out = await svcGetProductionGroup(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createProductionGroup = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createProductionGroupBodySchema.parse(req.body);
  const out = await svcCreateProductionGroup({ body, audit });
  res.status(201).json(out);
});

export const updateProductionGroup = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = productionGroupIdParamSchema.parse(req.params);
  const patch = updateProductionGroupBodySchema.parse(req.body);
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const out = await svcUpdateProductionGroup({ id, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const linkProductionGroup = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = productionGroupIdParamSchema.parse(req.params);
  const body = linkProductionGroupBodySchema.parse(req.body);
  const out = await svcLinkProductionGroup({ id, body, audit });
  res.status(200).json(out);
});

export const unlinkProductionGroup = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = productionGroupIdParamSchema.parse(req.params);
  const body = unlinkProductionGroupBodySchema.parse(req.body);
  const out = await svcUnlinkProductionGroup({ id, body, audit });
  res.status(200).json(out);
});
