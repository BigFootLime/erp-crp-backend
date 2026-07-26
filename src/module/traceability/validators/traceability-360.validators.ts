// Traçabilité industrielle 360 (#142) — validation stricte des entrées.
//
// `.strict()` partout : un paramètre inconnu est une erreur, pas un silence.
// Les bornes déclarées ici sont un premier filet ; les plafonds NON
// contournables restent appliqués côté domaine (`clampDepth`, `clampNodes`…),
// parce qu'un client ne doit jamais pouvoir élargir le périmètre serveur.

import { z } from "zod";

import {
  TRACEABILITY_DIRECTIONS,
  TRACEABILITY_NODE_TYPES,
  TRACEABILITY_RELATION_TYPES,
  LEGACY_TRACEABILITY_NODE_TYPES,
} from "../domain/traceability-model";
import { TRACEABILITY_LIMITS } from "../domain/traceability-policy";

export const traceabilityNodeTypeSchema = z.enum(TRACEABILITY_NODE_TYPES);
export const traceabilityRelationSchema = z.enum(TRACEABILITY_RELATION_TYPES);
export const traceabilityDirectionSchema = z.enum(TRACEABILITY_DIRECTIONS);
export const legacyTraceabilityNodeTypeSchema = z.enum(LEGACY_TRACEABILITY_NODE_TYPES);

function coerceInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/** `a,b,c` → `['a','b','c']`. Une liste vide vaut « pas de filtre ». */
function csv(value: unknown): string[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

const isoDate = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Date invalide." });

export const chainQuerySchema = z
  .object({
    type: traceabilityNodeTypeSchema,
    id: z.string().trim().min(1).max(64),
    direction: traceabilityDirectionSchema.optional(),
    as_of: isoDate.optional(),
    maxDepth: z.preprocess(coerceInt, z.number().int().min(0).max(TRACEABILITY_LIMITS.MAX_DEPTH)).optional(),
    maxNodes: z.preprocess(coerceInt, z.number().int().min(1).max(TRACEABILITY_LIMITS.MAX_NODES)).optional(),
    maxEdges: z.preprocess(coerceInt, z.number().int().min(1).max(TRACEABILITY_LIMITS.MAX_EDGES)).optional(),
    node_types: z.preprocess(csv, z.array(traceabilityNodeTypeSchema).max(40)).optional(),
    relations: z.preprocess(csv, z.array(traceabilityRelationSchema).max(60)).optional(),
    period_from: isoDate.optional(),
    period_to: isoDate.optional(),
  })
  .strict()
  .refine(
    (v) => !v.period_from || !v.period_to || Date.parse(v.period_from) <= Date.parse(v.period_to),
    { message: "La période est inversée.", path: ["period_to"] }
  );

export type ChainQueryDTO = z.infer<typeof chainQuerySchema>;

export const expandQuerySchema = z
  .object({
    type: traceabilityNodeTypeSchema,
    id: z.string().trim().min(1).max(64),
    direction: traceabilityDirectionSchema,
    as_of: isoDate.optional(),
    maxNodes: z.preprocess(coerceInt, z.number().int().min(1).max(200)).optional(),
    maxEdges: z.preprocess(coerceInt, z.number().int().min(1).max(400)).optional(),
  })
  .strict();

export type ExpandQueryDTO = z.infer<typeof expandQuerySchema>;

export const searchQuerySchema = z
  .object({
    // 2 caractères minimum : en dessous, l'autocomplétion renverrait un extrait
    // massif du référentiel, ce qui est une fuite de volume.
    q: z.string().trim().min(2).max(120),
    types: z.preprocess(csv, z.array(traceabilityNodeTypeSchema).max(40)).optional(),
    limit: z
      .preprocess(coerceInt, z.number().int().min(1).max(TRACEABILITY_LIMITS.SEARCH_MAX_LIMIT))
      .optional(),
    offset: z.preprocess(coerceInt, z.number().int().min(0).max(5000)).optional(),
  })
  .strict();

export type SearchQueryDTO = z.infer<typeof searchQuerySchema>;

export const impactQuerySchema = z
  .object({
    type: traceabilityNodeTypeSchema,
    id: z.string().trim().min(1).max(64),
    since: isoDate.optional(),
    as_of: isoDate.optional(),
    maxDepth: z.preprocess(coerceInt, z.number().int().min(1).max(TRACEABILITY_LIMITS.MAX_DEPTH)).optional(),
    node_types: z.preprocess(csv, z.array(traceabilityNodeTypeSchema).max(40)).optional(),
  })
  .strict();

export type ImpactQueryDTO = z.infer<typeof impactQuerySchema>;

/** Contrat HISTORIQUE de `GET /traceability/chain`, conservé à l'identique. */
export const legacyChainQuerySchema = z
  .object({
    type: legacyTraceabilityNodeTypeSchema,
    id: z.string().trim().min(1).max(64),
    maxDepth: z.preprocess(coerceInt, z.number().int().min(0).max(10)).optional(),
    maxNodes: z.preprocess(coerceInt, z.number().int().min(1).max(500)).optional(),
    maxEdges: z.preprocess(coerceInt, z.number().int().min(1).max(2000)).optional(),
  })
  .strict();

export type LegacyChainQueryDTO = z.infer<typeof legacyChainQuerySchema>;
