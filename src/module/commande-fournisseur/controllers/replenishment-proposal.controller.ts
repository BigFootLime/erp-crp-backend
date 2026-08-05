import type { Request, RequestHandler } from "express"

import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../repository/commande-fournisseur.repository"
import {
  listReplenishmentProposalsSVC,
  refreshReplenishmentProposalsSVC,
  validateReplenishmentProposalSVC,
} from "../services/replenishment-proposal.service"
import {
  listReplenishmentProposalsSchema,
  refreshReplenishmentProposalsSchema,
  validateReplenishmentProposalSchema,
} from "../validators/replenishment-proposal.validators"

function auditContext(req: Request): AuditContext {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")
  const forwarded = req.headers["x-forwarded-for"]
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() ?? null : req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
  }
}

export const listReplenishmentProposals: RequestHandler = async (req, res, next) => {
  try {
    const { query } = listReplenishmentProposalsSchema.parse({ query: req.query })
    res.json(await listReplenishmentProposalsSVC(query))
  } catch (error) { next(error) }
}

export const refreshReplenishmentProposals: RequestHandler = async (req, res, next) => {
  try {
    const { body } = refreshReplenishmentProposalsSchema.parse({ body: req.body ?? {} })
    res.json(await refreshReplenishmentProposalsSVC(body, auditContext(req)))
  } catch (error) { next(error) }
}

export const validateReplenishmentProposal: RequestHandler = async (req, res, next) => {
  try {
    const { params, body } = validateReplenishmentProposalSchema.parse({ params: req.params, body: req.body })
    res.json(await validateReplenishmentProposalSVC(params.id, body, auditContext(req)))
  } catch (error) { next(error) }
}
