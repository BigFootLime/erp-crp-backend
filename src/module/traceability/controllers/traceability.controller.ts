import type { RequestHandler } from "express"

import { HttpError } from "../../../utils/httpError"

import { svcGetTraceabilityChain } from "../services/traceability.service"
import { traceabilityChainQuerySchema } from "../validators/traceability.validators"

function getUserId(req: Express.Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")
  return userId
}

export const getTraceabilityChain: RequestHandler = async (req, res, next) => {
  try {
    getUserId(req)
    const query = traceabilityChainQuerySchema.parse(req.query)

    const maxDepth = query.maxDepth ?? 4
    const maxNodes = query.maxNodes ?? 120
    const maxEdges = query.maxEdges ?? 400

    const out = await svcGetTraceabilityChain({
      seed: { type: query.type, id: query.id },
      limits: { maxDepth, maxNodes, maxEdges },
    })

    res.json(out)
  } catch (e) {
    next(e)
  }
}
