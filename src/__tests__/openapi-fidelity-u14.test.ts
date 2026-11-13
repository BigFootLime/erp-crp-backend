import { describe, expect, it } from "vitest";

import {
  createMatiereNuanceSchema,
  createMatiereSousEtatSchema,
  updateMatiereEtatSchema,
} from "../module/stock/validators/stock.validators";
import {
  patchOfTechnicalPreparationSchema,
  submitOfTechnicalPreparationSchema,
  validateOfTechnicalPreparationSchema,
} from "../module/production/validators/production.validators";
import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";
import { buildOpenApiDocument } from "../swagger/openapi-contract";
import { swaggerSpec } from "../swagger/swagger";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as RecordValue;
}

function operation(path: string, method: string): RecordValue {
  return record(record(record(swaggerSpec.paths)[path])[method]);
}

function schemaReference(operationValue: RecordValue, response = false): string | undefined {
  const source = response
    ? record(record(record(operationValue.responses)["200"]).content)["application/json"]
    : record(record(record(operationValue.requestBody).content)["application/json"]);
  return record(source).schema && typeof record(source).schema === "object"
    ? record(record(source).schema).$ref as string | undefined
    : undefined;
}

function responseSchema(operationValue: RecordValue, status: string): RecordValue {
  return record(record(record(record(operationValue.responses)[status]).content)["application/json"]).schema as RecordValue;
}

describe("U14 OpenAPI fidelity", () => {
  it("reports structural route coverage separately from schema fidelity", () => {
    const structural = record(swaggerSpec["x-cerp-route-coverage"]);
    const fidelity = record(swaggerSpec["x-cerp-schema-fidelity"]);
    const operations = record(fidelity.operation);
    const request = record(fidelity.request);
    const response = record(fidelity.response);

    expect(structural.percent).toBe(100);
    expect(fidelity.denominator).toBe(GENERATED_ROUTE_INVENTORY.length);
    expect(Object.values(operations).reduce<number>((sum, value) => sum + Number(value), 0)).toBe(GENERATED_ROUTE_INVENTORY.length);
    expect(Object.values(request).reduce<number>((sum, value) => sum + Number(value), 0)).toBe(GENERATED_ROUTE_INVENTORY.length);
    expect(Object.values(response).reduce<number>((sum, value) => sum + Number(value), 0)).toBe(GENERATED_ROUTE_INVENTORY.length);
    expect(operations.generic).toBeGreaterThan(0);
    expect(operations.precise).toBeLessThan(GENERATED_ROUTE_INVENTORY.length);
    expect(String(fidelity.criteria)).toContain("ApiRequest/ApiResponse");
    for (const pathItem of Object.values(record(swaggerSpec.paths))) {
      for (const operationValue of Object.values(record(pathItem))) {
        const classification = record(record(operationValue)["x-cerp-schema-fidelity"]);
        if (classification.request === "unknown" || classification.response === "unknown") {
          expect(classification.overall).toBe("unknown");
        }
      }
    }

    const genericLegacyResponse = operation("/accounting-exports/batches", "get");
    expect(record(genericLegacyResponse["x-cerp-schema-fidelity"]).response).toBe("generic");
  });

  it("classifies recursive references and open object shapes conservatively", () => {
    // Exercise the builder through a synthetic legacy declaration rather than
    // duplicating its classifier. The live document is never mutated.
    const classify = (schema: RecordValue, schemas: RecordValue = {}) => {
      const document = buildOpenApiDocument({
        components: { schemas },
        paths: { "/accounting-exports/batches": { get: { responses: { "200": { description: "fixture", content: { "application/json": { schema } } } } } } },
      });
      return record(record(record(document.paths)["/accounting-exports/batches"])["get"])["x-cerp-schema-fidelity"] as RecordValue;
    };
    expect(classify({ $ref: "#/components/schemas/AliasA" }, {
      AliasA: { $ref: "#/components/schemas/AliasB" }, AliasB: { $ref: "#/components/schemas/AliasA" },
    }).response).toBe("unknown");
    expect(classify({ type: "object" }).response).toBe("generic");
    expect(classify({ type: "object", properties: { id: { type: "integer" } } }).response).toBe("partial");
    expect(classify({ type: "object", additionalProperties: { $ref: "#/components/schemas/ApiResponse" } }).response).toBe("generic");
    expect(classify({ type: "object", additionalProperties: false, properties: { payload: { $ref: "#/components/schemas/ApiResponse" } } }).response).toBe("partial");
    expect(classify({ allOf: [{ $ref: "#/components/schemas/Missing" }, { $ref: "#/components/schemas/ApiResponse" }] }).response).toBe("unknown");

    const mixedAxisDocument = buildOpenApiDocument({
      paths: {
        "/accounting-exports/batches": {
          get: {
            requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MissingRequest" } } } },
            responses: { "200": { description: "generic", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiResponse" } } } } },
          },
        },
      },
    });
    const mixedAxis = record(record(record(mixedAxisDocument.paths)["/accounting-exports/batches"])["get"])["x-cerp-schema-fidelity"] as RecordValue;
    expect(mixedAxis).toMatchObject({ request: "unknown", response: "generic", overall: "unknown" });
  });

  it("keeps consumer material-reference fixtures aligned with their real validators", () => {
    expect(createMatiereNuanceSchema.parse({ body: {
      norme_fr: "EN AW-6082", designation_principale: "FR", densite: 2700, etat_ids: [4], is_active: true,
    } }).body).toMatchObject({ norme_fr: "EN AW-6082", densite: 2700, etat_ids: [4] });
    for (const [key, value] of [["norme_fr", "  État A  "], ["norme_en", "  Ａ1  "], ["norme_usa", "  Ø-A  "], ["norme_fr", `  ${"A".repeat(40)}  `]] as const) {
      expect(createMatiereNuanceSchema.parse({ body: { [key]: value } }).body[key]).toBe(value.trim());
    }
    expect(createMatiereSousEtatSchema.parse({ body: {
      code: "ETIRE", etat_id: null, informations: "Contrôle matière\navant lancement", is_active: true,
    } }).body.informations).toBe("Contrôle matière\navant lancement");
    expect(updateMatiereEtatSchema.safeParse({ body: {} }).success).toBe(false);

    const nuanceCreate = operation("/stock/matiere-nuances", "post");
    const etatPatch = operation("/stock/matiere-etats/{id}", "patch");
    const sousEtatList = operation("/stock/matiere-sous-etats", "get");
    const nuanceList = operation("/stock/matiere-nuances", "get");
    const etatList = operation("/stock/matiere-etats", "get");
    expect(schemaReference(nuanceCreate)).toBeUndefined(); // nuanced contract is inline to express its at-least-one-standard rule.
    expect(schemaReference(etatPatch)).toBe("#/components/schemas/MaterialEtatPatch");
    expect(schemaReference(sousEtatList, true)).toBe("#/components/schemas/MaterialSousEtatList");
    expect(record(etatPatch.responses)).toHaveProperty("400");
    expect(record(etatPatch.responses)).toHaveProperty("404");
    expect(record(etatPatch.responses)).toHaveProperty("409");
    expect(record(sousEtatList.responses)).not.toHaveProperty("404");
    expect(record(sousEtatList["x-cerp-schema-fidelity"]).response).toBe("precise");
    expect((etatPatch.parameters as Array<RecordValue>).find((parameter) => parameter.name === "id")?.schema).toMatchObject({ type: "integer", minimum: 1 });
    expect((nuanceList.parameters as Array<RecordValue>).some((parameter) => parameter.name === "etat_id")).toBe(true);
    expect((etatList.parameters as Array<RecordValue>).some((parameter) => parameter.name === "nuance_id")).toBe(true);
    expect((sousEtatList.parameters as Array<RecordValue>).some((parameter) => parameter.name === "etat_id")).toBe(true);
    expect(responseSchema(nuanceCreate, "400").oneOf).toEqual([
      { $ref: "#/components/schemas/ZodValidationError" }, { $ref: "#/components/schemas/CompatMaterialError" },
    ]);
    expect(responseSchema(etatPatch, "404").oneOf).toEqual([
      { $ref: "#/components/schemas/ControllerInputError" }, { $ref: "#/components/schemas/CompatMaterialError" },
    ]);
    expect(responseSchema(etatPatch, "409").oneOf).toEqual([
      { $ref: "#/components/schemas/HttpErrorEnvelope" }, { $ref: "#/components/schemas/CompatMaterialError" },
    ]);
    expect(responseSchema(etatPatch, "400").oneOf).toEqual([
      { $ref: "#/components/schemas/ZodValidationError" },
      { $ref: "#/components/schemas/ControllerInputError" },
      { $ref: "#/components/schemas/HttpErrorEnvelope" },
      { $ref: "#/components/schemas/CompatMaterialError" },
    ]);
    const nuanceBody = record(record(record(nuanceCreate.requestBody).content)["application/json"]).schema as RecordValue;
    const nuanceAnyOf = nuanceBody.anyOf as Array<RecordValue>;
    expect(nuanceAnyOf).toHaveLength(4);
    expect(nuanceAnyOf[0]).toMatchObject({ required: ["norme_fr"], properties: { norme_fr: { type: "string", nullable: true } } });
    expect(record(record(nuanceBody.properties).norme_fr)).toMatchObject({ type: "string", nullable: true });
    expect(record(record(nuanceBody.properties).norme_fr)).not.toHaveProperty("pattern");
    expect(record(record(nuanceBody.properties).norme_fr)).not.toHaveProperty("maxLength");
    expect(nuanceBody).not.toHaveProperty("allOf");
    expect(nuanceBody["x-cerp-schema-fidelity-limitations"]).toEqual(["runtime_normalization"]);
    expect(record(nuanceCreate["x-cerp-schema-fidelity"])).toMatchObject({ request: "partial" });
    for (const name of ["MaterialNuanceCreate", "MaterialNuancePatch"]) {
      const component = record(record(record(swaggerSpec.components).schemas)[name]);
      expect(component["x-cerp-schema-fidelity-limitations"]).toEqual(["runtime_normalization"]);
      expect(record(record(component.properties).norme_fr)).toEqual(record(record(nuanceBody.properties).norme_fr));
    }
    const nuancePatch = operation("/stock/matiere-nuances/{id}", "patch");
    const patchBody = record(record(record(nuancePatch.requestBody).content)["application/json"]).schema as RecordValue;
    expect(patchBody["x-cerp-schema-fidelity-limitations"]).toEqual(["runtime_normalization"]);
    const sousEtatCreate = record(record(swaggerSpec.components).schemas).MaterialSousEtatCreate as RecordValue;
    expect(record(sousEtatCreate.properties).informations).toMatchObject({ maxLength: 10000, nullable: true });
    expect(record(record(swaggerSpec.components).schemas).MaterialEtatCreate).toMatchObject({ required: ["code"] });
    expect(record(record(swaggerSpec.components).schemas).CompatMaterialError).toMatchObject({ required: ["error", "message"], additionalProperties: false });
  });

  it("documents the UI technical-preparation workflow from its validators and real result shape", () => {
    expect(patchOfTechnicalPreparationSchema.parse({ body: {
      expected_updated_at: "2026-11-13T20:00:00.000Z",
      sections: { material: { confirmed: true } },
    } }).body.sections.material).toEqual({ confirmed: true });
    expect(submitOfTechnicalPreparationSchema.parse({ body: {} }).body).toEqual({});
    expect(validateOfTechnicalPreparationSchema.safeParse({ body: { material_review_version: "x".repeat(63) } }).success).toBe(false);

    const read = operation("/production/ofs/{id}/technical-preparation", "get");
    const patch = operation("/production/ofs/{id}/technical-preparation", "patch");
    const submit = operation("/production/ofs/{id}/technical-preparation/submit", "post");
    const validate = operation("/production/ofs/{id}/technical-preparation/validate", "post");
    expect(schemaReference(read, true)).toBe("#/components/schemas/OfTechnicalPreparation");
    expect(schemaReference(patch)).toBe("#/components/schemas/OfTechnicalPreparationPatch");
    expect(schemaReference(submit)).toBe("#/components/schemas/OfTechnicalPreparationSubmit");
    expect(schemaReference(validate)).toBe("#/components/schemas/OfTechnicalPreparationValidate");
    expect(record(patch.responses)).toHaveProperty("409");
    expect(record(submit.responses)).toHaveProperty("422");
    expect(record(validate.responses)).toHaveProperty("422");
    expect(record(read.responses)).not.toHaveProperty("422");
    expect(record(read["x-cerp-schema-fidelity"]).response).toBe("partial");
    expect(responseSchema(patch, "400").$ref).toBe("#/components/schemas/ZodValidationError");
    expect(responseSchema(patch, "404").$ref).toBe("#/components/schemas/ControllerInputError");
    expect(responseSchema(patch, "409").$ref).toBe("#/components/schemas/HttpErrorEnvelope");
    expect(responseSchema(submit, "422").$ref).toBe("#/components/schemas/HttpErrorEnvelope");
    expect(record(record(swaggerSpec.components).schemas).OfTechnicalPreparationSections).toMatchObject({ additionalProperties: true });
  });
});
