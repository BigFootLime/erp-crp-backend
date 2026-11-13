import { combinedErrors } from "./error-response-contract";
import { nuanceStandardInputSchema } from "./nuance-library-contract";

type Schema = Record<string, unknown>;
type Operation = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ "application/json": { schema } });
const positiveInteger: Schema = { type: "integer", minimum: 1 };
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true });

const normeProperties = {
  norme_fr: nullable({ type: "string", maxLength: 40 }),
  norme_en: nullable({ type: "string", maxLength: 40 }),
  norme_werkstoff: nullable({ type: "string", maxLength: 40 }),
  norme_usa: nullable({ type: "string", maxLength: 40 }),
};
const rawNormeProperties = Object.fromEntries(Object.keys(normeProperties).map((name) => [name, nuanceStandardInputSchema]));

export const materialReferentialSchemas: Record<string, Schema> = {
  MaterialNuance: {
    type: "object", additionalProperties: false,
    required: ["id", "code", "designation", "densite", "is_active", "etat_ids"],
    properties: {
      id: positiveInteger, code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      densite: nullable({ type: "number", minimum: 100, maximum: 30000 }),
      is_active: { type: "boolean" }, etat_ids: { type: "array", items: positiveInteger },
      designation_principale: { type: "string", enum: ["FR", "EN", "WERKSTOFF", "USA", "LEGACY"] },
      libelle: { type: "string" }, ...normeProperties,
    },
  },
  MaterialEtat: {
    type: "object", additionalProperties: false,
    required: ["id", "code", "designation", "unite_achat", "is_active", "nuance_ids"],
    properties: {
      id: positiveInteger, code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }), unite_achat: positiveInteger,
      is_active: { type: "boolean" }, nuance_ids: { type: "array", items: positiveInteger },
    },
  },
  MaterialSousEtat: {
    type: "object", additionalProperties: false,
    required: ["id", "etat_id", "code", "designation", "informations", "is_active"],
    properties: {
      id: positiveInteger, etat_id: nullable(positiveInteger),
      code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      informations: nullable({ type: "string", maxLength: 10000 }), is_active: { type: "boolean" },
    },
  },
  MaterialNuanceCreate: {
    type: "object", additionalProperties: false,
    "x-cerp-schema-fidelity-limitations": ["runtime_normalization"],
    description: "Les normes brutes sont trimées et validées par le serveur, avec au moins une norme significative et une désignation principale renseignée.",
    properties: {
      ...rawNormeProperties, code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      designation_principale: { type: "string", enum: ["FR", "EN", "WERKSTOFF", "USA"] },
      densite: nullable({ type: "number", minimum: 100, maximum: 30000 }),
      etat_ids: { type: "array", items: positiveInteger }, is_active: { type: "boolean" },
    },
    anyOf: ["norme_fr", "norme_en", "norme_werkstoff", "norme_usa"].map((name) => ({ required: [name] })),
  },
  MaterialNuancePatch: {
    type: "object", additionalProperties: false, minProperties: 1,
    "x-cerp-schema-fidelity-limitations": ["runtime_normalization"],
    description: "Les normes brutes sont trimées puis fusionnées avec l’identité existante ; la cohérence de l’identité finale reste validée par le serveur.",
    properties: {
      ...rawNormeProperties, code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      designation_principale: { type: "string", enum: ["FR", "EN", "WERKSTOFF", "USA", "LEGACY"] },
      densite: nullable({ type: "number", minimum: 100, maximum: 30000 }), is_active: { type: "boolean" },
    },
  },
  MaterialEtatCreate: {
    type: "object", additionalProperties: false, required: ["code"],
    properties: {
      code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }), unite_achat: positiveInteger,
      nuance_ids: { type: "array", items: positiveInteger }, is_active: { type: "boolean" },
    },
  },
  MaterialEtatPatch: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }), unite_achat: positiveInteger,
      is_active: { type: "boolean" },
    },
  },
  MaterialSousEtatCreate: {
    type: "object", additionalProperties: false, required: ["code"],
    properties: {
      etat_id: nullable(positiveInteger), code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      informations: nullable({ type: "string", maxLength: 10000 }), is_active: { type: "boolean" },
    },
  },
  MaterialSousEtatPatch: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      code: { type: "string", minLength: 1, maxLength: 40 },
      designation: nullable({ type: "string", maxLength: 160 }),
      informations: nullable({ type: "string", maxLength: 10000 }), is_active: { type: "boolean" },
    },
  },
  MaterialReferentialCapabilities: {
    type: "object", additionalProperties: false, required: ["read", "write"],
    properties: { read: { type: "boolean", enum: [true] }, write: { type: "boolean", enum: [true] } },
  },
};

const materialKinds = {
  "/stock/matiere-nuances": ["MaterialNuance", "MaterialNuanceCreate", "MaterialNuancePatch"],
  "/stock/matiere-etats": ["MaterialEtat", "MaterialEtatCreate", "MaterialEtatPatch"],
  "/stock/matiere-sous-etats": ["MaterialSousEtat", "MaterialSousEtatCreate", "MaterialSousEtatPatch"],
} as const;

function responses(operation: Operation, schema: string, mode: "capabilities" | "list" | "create" | "update"): Operation {
  const errors: Operation = {};
  if (mode === "list") errors["400"] = combinedErrors(
    { $ref: "#/components/schemas/ControllerInputError" }, { $ref: "#/components/schemas/CompatMaterialError" },
  );
  if (mode === "create") errors["400"] = combinedErrors(
    { $ref: "#/components/schemas/ZodValidationError" }, { $ref: "#/components/schemas/CompatMaterialError" },
  );
  if (mode === "update") errors["400"] = combinedErrors(
    { $ref: "#/components/schemas/ZodValidationError" },
    { $ref: "#/components/schemas/ControllerInputError" },
    { $ref: "#/components/schemas/HttpErrorEnvelope" },
    { $ref: "#/components/schemas/CompatMaterialError" },
  );
  if (mode === "create" || mode === "update") {
    errors["409"] = combinedErrors(
      { $ref: "#/components/schemas/HttpErrorEnvelope" }, { $ref: "#/components/schemas/CompatMaterialError" },
    );
  }
  if (mode === "update") errors["404"] = combinedErrors(
    { $ref: "#/components/schemas/ControllerInputError" }, { $ref: "#/components/schemas/CompatMaterialError" },
  );
  return {
    ...(operation.responses as Operation),
    [mode === "create" ? "201" : "200"]: { description: mode === "create" ? "Référentiel créé." : "Référentiel renvoyé.", content: json(ref(schema)) },
    ...errors,
  };
}

export function materialReferentialOperation(key: string, operation: Operation): Operation {
  if (key === "get /stock/matiere-referential-capabilities") {
    return { ...operation, summary: "Capacités du référentiel matière", responses: responses(operation, "MaterialReferentialCapabilities", "capabilities") };
  }
  const [method, path] = key.split(" ");
  const collectionPath = path.replace("/{id}", "");
  const kind = materialKinds[collectionPath as keyof typeof materialKinds];
  if (!kind) return operation;
  const [row, create, patch] = kind;
  if (method === "get") {
    const filter = {
      "/stock/matiere-nuances": "etat_id",
      "/stock/matiere-etats": "nuance_id",
      "/stock/matiere-sous-etats": "etat_id",
    }[collectionPath];
    if (!filter) return operation;
    return {
      ...operation, summary: `Lister ${collectionPath.split("/").at(-1)}`,
      parameters: [
        { name: "q", in: "query", required: false, schema: { type: "string" } },
        { name: filter, in: "query", required: false, schema: positiveInteger },
        { name: "is_active", in: "query", required: false, schema: { type: "boolean" } },
      ],
      responses: responses(operation, `${row}List`, "list"),
    };
  }
  if (method === "post") return {
    ...operation, requestBody: { required: true, content: json(ref(create)) }, responses: responses(operation, row, "create"),
  };
  if (method === "patch") return {
    ...operation,
    parameters: [{ name: "id", in: "path", required: true, schema: positiveInteger }],
    requestBody: { required: true, content: json(ref(patch)) }, responses: responses(operation, row, "update"),
  };
  return operation;
}

for (const row of ["MaterialNuance", "MaterialEtat", "MaterialSousEtat"] as const) {
  materialReferentialSchemas[`${row}List`] = {
    type: "object", additionalProperties: false, required: ["items", "total"],
    properties: { items: { type: "array", items: ref(row) }, total: { type: "integer", minimum: 0 } },
  };
}
