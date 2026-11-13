import { controllerInputError, httpError, zodValidationError } from "./error-response-contract";

type Schema = Record<string, unknown>;
type Operation = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ "application/json": { schema } });

const sectionKeys = ["plan", "material", "structure", "routing", "documents", "quality", "stock_compatibility"];

export const ofTechnicalPreparationSchemas: Record<string, Schema> = {
  OfTechnicalPreparationSections: {
    type: "object", additionalProperties: true,
    description: "Les sections inconnues sont acceptées à la frontière puis supprimées par le schéma Zod ; seules les clés déclarées sont persistées.",
    properties: Object.fromEntries(sectionKeys.map((key) => [key, { type: "object", additionalProperties: true }])),
  },
  OfTechnicalPreparation: {
    type: "object", additionalProperties: true,
    required: ["id", "numero", "statut", "technical_readiness", "technical_preparation", "piece_technique_id", "piece_technique_version_id", "updated_at", "missing_sections"],
    properties: {
      id: { type: "integer", minimum: 1 }, numero: { type: "string" },
      statut: { type: "string", enum: ["BROUILLON", "PLANIFIE", "EN_COURS", "EN_PAUSE", "TERMINE", "CLOTURE", "ANNULE"] },
      technical_readiness: { type: "string", enum: ["INCOMPLETE", "READY_FOR_REVIEW", "VALIDATED", "BLOCKED"] },
      technical_preparation: { type: "object", additionalProperties: true, properties: {
        selected_version_id: { type: "string", format: "uuid", nullable: true }, sections: ref("OfTechnicalPreparationSections"),
      } },
      piece_technique_id: { type: "string", format: "uuid" },
      piece_technique_version_id: { type: "string", format: "uuid", nullable: true }, updated_at: { type: "string", format: "date-time" },
      missing_sections: { type: "array", items: { type: "string", enum: sectionKeys } }, can_validate: { type: "boolean" },
    },
  },
  OfTechnicalPreparationPatch: {
    type: "object", additionalProperties: false,
    properties: {
      expected_updated_at: { type: "string", format: "date-time" },
      selected_version_id: { type: "string", format: "uuid", nullable: true }, sections: ref("OfTechnicalPreparationSections"),
    },
  },
  OfTechnicalPreparationSubmit: { type: "object", additionalProperties: false, properties: { expected_updated_at: { type: "string", format: "date-time" } } },
  OfTechnicalPreparationValidate: {
    type: "object", additionalProperties: false,
    properties: { expected_updated_at: { type: "string", format: "date-time" }, material_review_version: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  },
};

function responses(operation: Operation, mode: "read" | "patch" | "submit" | "validate"): Operation {
  const errors: Operation = { "400": zodValidationError(), "404": controllerInputError() };
  if (mode !== "read") errors["409"] = httpError();
  if (mode === "submit" || mode === "validate") errors["422"] = httpError();
  return {
    ...(operation.responses as Operation),
    "200": { description: "État actuel de la préparation technique.", content: json(ref("OfTechnicalPreparation")) },
    ...errors,
  };
}

export function ofTechnicalPreparationOperation(key: string, operation: Operation): Operation {
  const requestSchema = key === "patch /production/ofs/{id}/technical-preparation"
    ? "OfTechnicalPreparationPatch"
    : key === "post /production/ofs/{id}/technical-preparation/submit"
      ? "OfTechnicalPreparationSubmit"
      : key === "post /production/ofs/{id}/technical-preparation/validate"
        ? "OfTechnicalPreparationValidate"
        : null;
  if (key !== "get /production/ofs/{id}/technical-preparation" && !requestSchema) return operation;
  const mode = key.startsWith("get ") ? "read" : key.startsWith("patch ") ? "patch" : key.endsWith("/submit") ? "submit" : "validate";
  return {
    ...operation,
    summary: "Lire ou faire progresser la préparation technique d’un OF",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    ...(requestSchema ? { requestBody: { required: true, content: json(ref(requestSchema)) } } : {}),
    responses: responses(operation, mode),
  };
}
