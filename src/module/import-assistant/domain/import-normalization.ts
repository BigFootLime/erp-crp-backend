import type { ZodIssue, ZodTypeAny } from "zod";
import { z } from "zod";

import {
  clientPatchSchema,
  createClientContactBodySchema,
  createClientSchema,
} from "../../client/validators/client.validators";
import {
  createCommandeSchema,
  ligneInputSchema,
} from "../../commande-fournisseur/validators/commande-fournisseur.validators";
import { createFournisseurSchema } from "../../fournisseurs/validators/fournisseurs.validators";
import { createPieceTechniqueSchema } from "../../pieces-techniques/validators/pieces-techniques.validators";
import { createMachineSchema } from "../../production/validators/production.validators";
import { createArticleSchema } from "../../stock/validators/stock.validators";
import { getImportCapability } from "./import-capabilities";
import type {
  ImportEntityType,
  ImportFieldKind,
  ImportIssue,
  ImportMapping,
  ImportTargetField,
} from "../types/import-assistant.types";

type NormalizedResult = {
  legacy_key: string | null;
  normalized_data: Record<string, unknown> | null;
  issues: ImportIssue[];
};

const clientEnrichmentSchema = clientPatchSchema
  .refine((value) => Object.keys(value).length > 0, {
    message: "Au moins une donnée client doit être fournie.",
  });

const clientContactImportSchema = z.object({
  client_legacy_code: z.string().trim().min(1, "Code client CLIPPER requis"),
  ...createClientContactBodySchema.shape,
});

const fournisseurCommandeImportSchema = createCommandeSchema.shape.body
  .omit({ fournisseur_id: true, idempotency_key: true })
  .extend({
    fournisseur_legacy_code: z.string().trim().min(1, "Code fournisseur CLIPPER requis"),
    date_commande_source: z.string().regex(
      /^\d{4}-\d{2}-\d{2}$/,
      "Date de commande CLIPPER attendue au format AAAA-MM-JJ"
    ),
    lignes: z.array(ligneInputSchema).min(1, "Une commande importée doit contenir au moins une ligne.").max(200),
  })
  .strict();

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[part];
  }, target);
}

function normalizeBoolean(value: unknown): boolean | unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "vrai", "oui", "o", "yes", "y", "x"].includes(normalized)) return true;
  if (["0", "false", "faux", "non", "n", "no", ""].includes(normalized)) return false;
  return value;
}

function normalizeNumber(value: unknown): number | unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeDate(value: unknown): string | unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const french = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(trimmed);
  if (french) return `${french[3]}-${french[2].padStart(2, "0")}-${french[1].padStart(2, "0")}`;
  return value;
}

function normalizeValue(value: unknown, kind: ImportFieldKind): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (kind === "boolean") return normalizeBoolean(value);
  if (kind === "number") return normalizeNumber(value);
  if (kind === "date") return normalizeDate(value);
  if (kind === "list") {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return String(value).split(/[;|]/).map((item) => item.trim()).filter(Boolean);
  }
  return typeof value === "string" ? value.trim() : value;
}

function sourceValue(
  row: Record<string, unknown>,
  mapping: ImportMapping,
  targetField: ImportTargetField
): unknown {
  if (hasOwn(mapping.constants, targetField.key)) return mapping.constants[targetField.key];
  const sourceColumn = mapping.columns[targetField.key];
  return sourceColumn ? row[sourceColumn] : undefined;
}

function issueFromZod(issue: ZodIssue, row: Record<string, unknown>, mapping: ImportMapping, fields: ImportTargetField[]): ImportIssue {
  const field = issue.path.filter((part) => part !== "body").join(".");
  const definition = fields.find((candidate) => candidate.key === field);
  const sourceColumn = definition ? mapping.columns[definition.key] : null;
  const source = sourceColumn ? row[sourceColumn] : undefined;
  return {
    code: issue.code.toUpperCase(),
    message: issue.message,
    field: field || null,
    ...(source !== undefined ? { source_value: definition?.sensitive ? "[MASQUÉ]" : source } : {}),
  };
}

function entitySchema(entityType: ImportEntityType): { schema: ZodTypeAny; wrapped: boolean } | null {
  switch (entityType) {
    case "CLIENT":
      return { schema: createClientSchema, wrapped: false };
    case "CLIENT_ENRICHISSEMENT":
      return { schema: clientEnrichmentSchema, wrapped: false };
    case "CLIENT_CONTACT":
      return { schema: clientContactImportSchema, wrapped: false };
    case "FOURNISSEUR":
      return { schema: createFournisseurSchema, wrapped: true };
    case "FOURNISSEUR_COMMANDE":
      return { schema: fournisseurCommandeImportSchema, wrapped: false };
    case "ARTICLE":
      return { schema: createArticleSchema, wrapped: true };
    case "PIECE_TECHNIQUE":
      return { schema: createPieceTechniqueSchema, wrapped: true };
    case "MACHINE":
      return { schema: createMachineSchema, wrapped: true };
    default:
      return null;
  }
}

function postProcess(
  entityType: ImportEntityType,
  draft: Record<string, unknown>,
  legacyKey: string,
  issues: ImportIssue[]
) {
  if (entityType === "FOURNISSEUR") {
    const domaines = draft.domaines;
    if (Array.isArray(domaines)) {
      draft.domaines = domaines.map((domaine, index) => ({
        domaine_code: String(domaine),
        is_primary: index === 0,
      }));
    }
    const address = draft.adresse;
    if (address && typeof address === "object" && !Array.isArray(address)) {
      const values = Object.values(address as Record<string, unknown>).filter((value) => value !== undefined);
      if (values.length > 0) {
        draft.adresses = [{
          ...(address as Record<string, unknown>),
          is_primary: true,
        }];
      }
      delete draft.adresse;
    }
  }
  if (entityType === "CLIENT") {
    draft.payment_mode_ids = [];
    draft.quality_levels = [];
    draft.contacts = [];
  }
  if (entityType === "FOURNISSEUR_COMMANDE") {
    const rawLines = draft.lignes_json;
    delete draft.lignes_json;
    if (typeof rawLines === "string") {
      try {
        const parsed = JSON.parse(rawLines);
        if (!Array.isArray(parsed)) throw new Error("Le JSON doit contenir un tableau.");
        draft.lignes = parsed;
      } catch {
        issues.push({
          code: "INVALID_LINES_JSON",
          message: "Les lignes de commande ne forment pas un tableau JSON valide.",
          field: "lignes_json",
          source_value: "[MASQUÉ]",
        });
      }
    }
    const provenance = `Migration CLIPPER — BC ${legacyKey} du ${String(draft.date_commande_source ?? "")}`;
    draft.note_interne = draft.note_interne
      ? `${provenance}\n${String(draft.note_interne)}`
      : provenance;
  }
}

export function validateMapping(entityType: ImportEntityType, headers: string[], mapping: ImportMapping): ImportIssue[] {
  const capability = getImportCapability(entityType);
  if (!capability) return [{ code: "ENTITY_UNSUPPORTED", message: "Type d’entité inconnu.", field: null }];
  const headerSet = new Set(headers);
  const issues: ImportIssue[] = [];
  if (!mapping.legacy_key_column || !headerSet.has(mapping.legacy_key_column)) {
    issues.push({ code: "LEGACY_KEY_REQUIRED", message: "Choisissez la colonne de référence CLIPPER.", field: "legacy_key_column" });
  }
  for (const [target, source] of Object.entries(mapping.columns)) {
    if (!capability.fields.some((field) => field.key === target)) {
      issues.push({ code: "UNKNOWN_TARGET_FIELD", message: `Champ cible inconnu : ${target}`, field: target });
    }
    if (source && !headerSet.has(source)) {
      issues.push({ code: "UNKNOWN_SOURCE_COLUMN", message: `Colonne source absente : ${source}`, field: target });
    }
  }
  for (const field of capability.fields.filter((candidate) => candidate.required)) {
    if (!mapping.columns[field.key] && !hasOwn(mapping.constants, field.key)) {
      issues.push({ code: "REQUIRED_MAPPING", message: `Le champ « ${field.label} » doit être mappé ou recevoir une valeur fixe.`, field: field.key });
    }
  }
  return issues;
}

export function normalizeImportRow(
  entityType: ImportEntityType,
  row: Record<string, unknown>,
  mapping: ImportMapping
): NormalizedResult {
  const capability = getImportCapability(entityType);
  if (!capability) return { legacy_key: null, normalized_data: null, issues: [{ code: "ENTITY_UNSUPPORTED", message: "Type d’entité inconnu.", field: null }] };
  const legacyRaw = row[mapping.legacy_key_column];
  const legacyKey = legacyRaw === null || legacyRaw === undefined ? "" : String(legacyRaw).trim();
  const issues: ImportIssue[] = [];
  if (!legacyKey) issues.push({ code: "LEGACY_KEY_EMPTY", message: "La référence CLIPPER est vide.", field: "legacy_key" });

  const draft: Record<string, unknown> = {};
  for (const targetField of capability.fields) {
    const value = normalizeValue(sourceValue(row, mapping, targetField), targetField.kind);
    if (value !== undefined) setPath(draft, targetField.key, value);
  }
  postProcess(entityType, draft, legacyKey, issues);

  const schemaDefinition = entitySchema(entityType);
  if (!schemaDefinition) {
    return {
      legacy_key: legacyKey || null,
      normalized_data: null,
      issues: [...issues, { code: "CONFIRMATION_DISABLED", message: capability.unavailable_reason ?? "Confirmation indisponible.", field: null }],
    };
  }
  const candidate = schemaDefinition.wrapped ? { body: draft } : draft;
  const parsed = schemaDefinition.schema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((issue) => issueFromZod(issue, row, mapping, capability.fields)));
    return { legacy_key: legacyKey || null, normalized_data: draft, issues };
  }
  const normalized = schemaDefinition.wrapped
    ? ((parsed.data as { body: Record<string, unknown> }).body)
    : (parsed.data as Record<string, unknown>);
  return { legacy_key: legacyKey || null, normalized_data: normalized, issues };
}

export function importRowDedupeKeys(entityType: ImportEntityType, normalized: Record<string, unknown>) {
  const stringAt = (path: string) => {
    const value = getPath(normalized, path);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  switch (entityType) {
    case "CLIENT":
      return {
        siret: stringAt("siret"),
        secondary: stringAt("vat_number"),
        name: normalizeImportName(stringAt("company_name")),
      };
    case "CLIENT_ENRICHISSEMENT":
      return {
        siret: stringAt("siret"),
        secondary: stringAt("vat_number"),
        name: normalizeImportName(stringAt("company_name")),
      };
    case "FOURNISSEUR":
      return {
        siret: stringAt("siret"),
        secondary: stringAt("tva"),
        name: normalizeImportName(stringAt("nom")),
      };
    case "MACHINE":
      return { siret: null, secondary: stringAt("serial_number"), name: null };
    default:
      return { siret: null, secondary: null, name: null };
  }
}

export function normalizeImportName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  return normalized || null;
}
