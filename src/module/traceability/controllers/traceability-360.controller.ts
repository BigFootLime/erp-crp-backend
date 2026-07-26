// Traçabilité industrielle 360 (#142) — contrôleurs HTTP.
//
// Les contrôleurs ne contiennent aucune règle métier : ils valident, délèguent
// au service, et tracent les consultations sensibles. Ils n'écrivent jamais de
// donnée industrielle.

import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

import {
  svcExpandTraceabilityNode,
  svcGetTraceabilityChain,
  svcPreviewTraceabilityImpact,
  svcSearchTraceability,
  toLegacyChainResult,
} from "../services/traceability-360.service";
import { capabilitiesForRole } from "../domain/traceability-policy";
import {
  chainQuerySchema,
  expandQuerySchema,
  impactQuerySchema,
  legacyChainQuerySchema,
  searchQuerySchema,
} from "../validators/traceability-360.validators";

function requireUser(req: Request): { id: number; role: string | null } {
  const id = typeof req.user?.id === "number" ? req.user.id : null;
  if (!id) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { id, role: (req.user?.role as string | undefined) ?? null };
}

/**
 * Journal d'audit : QUI a consulté QUOI. Distinct de la traçabilité
 * industrielle (matières, lots, transformations) et des événements temps réel.
 * Aucun de ces trois ne remplace les deux autres.
 *
 * On ne journalise ni le terme de recherche complet ni aucune donnée
 * personnelle : le code métier consulté suffit à reconstituer l'usage.
 */
async function auditAccess(
  req: Request,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>
): Promise<void> {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) return;
  try {
    await repoInsertAuditLog({
      user_id: userId,
      body: {
        event_type: "ACTION",
        action,
        page_key: "traceabilite",
        entity_type: entityType,
        entity_id: entityId,
        path: req.originalUrl.split("?")[0],
        client_session_id: null,
        details,
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
    });
  } catch {
    // Un journal d'audit indisponible ne doit pas empêcher une lecture ; il est
    // en revanche hors de question de le désactiver silencieusement pour les
    // écritures — ce module n'en fait aucune.
  }
}

/* -------------------------------------------------------------------------- */
/* Recherche universelle                                                      */
/* -------------------------------------------------------------------------- */

export const searchTraceability: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = searchQuerySchema.parse(req.query);
    const out = await svcSearchTraceability({
      term: query.q,
      role: user.role,
      types: query.types ?? null,
      limit: query.limit,
      offset: query.offset,
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
};

/* -------------------------------------------------------------------------- */
/* Chaîne                                                                     */
/* -------------------------------------------------------------------------- */

export const getChain: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = chainQuerySchema.parse(req.query);
    const out = await svcGetTraceabilityChain({
      seed: { type: query.type, id: query.id },
      role: user.role,
      direction: query.direction,
      asOf: query.as_of ?? null,
      maxDepth: query.maxDepth,
      maxNodes: query.maxNodes,
      maxEdges: query.maxEdges,
      nodeTypes: query.node_types ?? null,
      relations: query.relations ?? null,
      periodFrom: query.period_from ?? null,
      periodTo: query.period_to ?? null,
    });
    await auditAccess(req, "traceability.chain.read", query.type, query.id, {
      code: out.seed.code,
      direction: out.scope.direction,
      nodes: out.summary.node_count,
      edges: out.summary.edge_count,
      coverage: out.coverage.state,
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
};

export const expandNode: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = expandQuerySchema.parse(req.query);
    const out = await svcExpandTraceabilityNode({
      node: { type: query.type, id: query.id },
      role: user.role,
      direction: query.direction,
      asOf: query.as_of ?? null,
      maxNodes: query.maxNodes,
      maxEdges: query.maxEdges,
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
};

/* -------------------------------------------------------------------------- */
/* Prévisualisation d'impact                                                  */
/* -------------------------------------------------------------------------- */

export const previewImpact: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = impactQuerySchema.parse(req.query);
    const out = await svcPreviewTraceabilityImpact({
      seed: { type: query.type, id: query.id },
      role: user.role,
      since: query.since ?? null,
      asOf: query.as_of ?? null,
      maxDepth: query.maxDepth,
      nodeTypes: query.node_types ?? null,
    });
    // Une simulation d'impact prépare une décision qualité : elle est tracée,
    // même si elle ne modifie rien.
    await auditAccess(req, "traceability.impact.preview", query.type, query.id, {
      code: out.seed.code,
      confirmed: out.counts.CONFIRMED,
      to_analyse: out.counts.TO_ANALYSE,
      insufficient: out.counts.INSUFFICIENT_DATA,
      since: query.since ?? null,
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
};

/* -------------------------------------------------------------------------- */
/* Capacités de l'appelant                                                    */
/* -------------------------------------------------------------------------- */

export const getCapabilities: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ capabilities: capabilitiesForRole(user.role) });
  } catch (e) {
    next(e);
  }
};

/* -------------------------------------------------------------------------- */
/* Contrat historique                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v1/traceability/chain` : réponse strictement identique à celle que
 * les écrans déployés attendent, mais servie par le nouveau moteur (sans N+1)
 * et désormais protégée par RBAC — ce qui n'était pas le cas.
 */
export const getLegacyChain: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = legacyChainQuerySchema.parse(req.query);
    const out = await svcGetTraceabilityChain({
      seed: { type: query.type, id: query.id },
      role: user.role,
      direction: "both",
      maxDepth: query.maxDepth ?? 4,
      maxNodes: query.maxNodes ?? 120,
      maxEdges: query.maxEdges ?? 400,
    });
    res.json(toLegacyChainResult(out));
  } catch (e) {
    next(e);
  }
};
