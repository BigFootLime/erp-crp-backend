type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** Error envelopes emitted by the middleware and controllers used below. */
export const errorResponseSchemas: Record<string, Schema> = {
  ZodValidationError: {
    type: "object", additionalProperties: false, required: ["error", "message", "errors"],
    properties: {
      error: { type: "string", enum: ["VALIDATION_ERROR"] }, message: { type: "string" },
      errors: { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "message"], properties: { field: { type: "string" }, message: { type: "string" } } } },
    },
  },
  ControllerInputError: {
    type: "object", additionalProperties: false, required: ["error"],
    properties: { error: { type: "string" } },
  },
  CompatMaterialError: {
    type: "object", additionalProperties: false, required: ["error", "message"],
    properties: { error: { type: "string" }, message: { type: "string" } },
  },
  HttpErrorEnvelope: {
    type: "object", additionalProperties: false, required: ["success", "message", "code", "path"],
    properties: { success: { type: "boolean", enum: [false] }, message: { type: "string" }, code: { type: "string" }, path: { type: "string" }, details: {} },
  },
};

export const jsonError = (schema: Schema) => ({ description: "Erreur conforme à l’enveloppe émise par la frontière HTTP.", content: { "application/json": { schema } } });
export const controllerInputError = () => jsonError(ref("ControllerInputError"));
export const compatMaterialError = () => jsonError(ref("CompatMaterialError"));
export const zodValidationError = () => jsonError(ref("ZodValidationError"));
export const httpError = () => jsonError(ref("HttpErrorEnvelope"));
export const combinedErrors = (...schemas: Schema[]) => jsonError({ oneOf: schemas });
