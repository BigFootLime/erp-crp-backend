type ObjectSchema = Record<string, unknown>;
const uuid = { type: "string", format: "uuid" },
  quantity = { type: "number", minimum: 0 },
  positive = { type: "number", exclusiveMinimum: true, minimum: 0 };
export const RECEIPT_PROCESSING_ACTIONS = [
  "pack",
  "stock",
  "tool-stock",
  "stock-article",
  "subcontract-origins",
  "reconcile-processing",
  "void-packaging",
] as const;
const stages = ["TO_CONTROL", "TO_PACK", "TO_STOCK", "DONE", "BLOCKED"];
const materialBars = { type: 'array', minItems: 1, maxItems: 1000, description: 'Barres réellement reçues. Le total doit égaler la quantité convertie en mm ; 1 000 barres maximum par entrée.', items: {
  type: 'object', additionalProperties: false, required: ['lengthMm','count'], properties: {
    lengthMm: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 1000000000, multipleOf: .001 },
    count: { type: 'integer', minimum: 1, maximum: 1000 },
  },
} };
export const receiptProcessingSchemas: Record<string, ObjectSchema> = {
  ReceiptProcessingLine: {
    type: "object",
    required: [
      "id",
      "receptionId",
      "policy",
      "version",
      "received",
      "accepted",
      "packed",
      "stocked",
      "stage",
      "queues",
      "blocking",
    ],
    properties: {
      id: uuid,
      receptionId: uuid,
      articleId: uuid,
      stockArticleId: { ...uuid, nullable: true },
      lotId: { ...uuid, nullable: true },
      controlId: { ...uuid, nullable: true },
      articleCode: { type: "string" },
      stockArticleCode: { type: "string", nullable: true },
      receptionNumber: { type: "string" },
      unit: { type: "string" },
      stockUnit: { type: "string" },
      coefficient: positive,
      materialBarProposal: { type: 'object', properties: {
        required: { type: 'boolean' }, groups: { ...materialBars, nullable: true },
        source: { type: 'string', nullable: true, enum: ['PURCHASE_CONVERSION','ARTICLE'] },
      } },
      policy: {
        type: "string",
        enum: ["STANDARD", "PIECES_CONTROLE_EMBALLAGE"],
      },
      version: { type: "integer", minimum: 1 },
      reconciliationRequired: { type: "boolean" },
      received: quantity,
      accepted: quantity,
      packed: quantity,
      stocked: quantity,
      disposed: quantity,
      toolId: { type: "integer", nullable: true },
      stockManaged: { type: "boolean" },
      qualityRequired: { type: "boolean" },
      operatorControl: { type: "object", required: ["kind", "reopenRequired", "dimensions"], properties: {
        kind: { type: "string", enum: ["MP"] }, reopenRequired: { type: "boolean" }, grade: { type: "string" },
        dimensions: { type: "array", items: { type: "object", required: ["label", "valueMm"], properties: {
          label: { type: "string" }, valueMm: { type: "number", nullable: true }, minimumMm: positive,
        } } },
      } },
      stage: { type: "string", enum: stages },
      queues: {
        type: "object",
        required: ["TO_CONTROL", "TO_PACK", "TO_STOCK"],
        properties: {
          TO_CONTROL: quantity,
          TO_PACK: quantity,
          TO_STOCK: quantity,
        },
      },
      blocking: { type: "array", items: { type: "string" } },
      allowedActions: {
        type: "array",
        items: { type: "string", enum: [...RECEIPT_PROCESSING_ACTIONS, "operator-control"] },
      },
      packagings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: uuid,
            quantity: positive,
            stocked: quantity,
            packaging: { type: "string" },
            packageCount: { type: "integer", minimum: 1 },
            createdAt: { type: "string", format: "date-time" },
            voidedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      },
      subcontract: {
        type: "object",
        nullable: true,
        description:
          "Dossier, OF, opération, événements ISSUE/RETURN, lots expédiés et quantités disponibles pour rattachement.",
      },
    },
  },
  ReceiptProcessingQueue: {
    type: "object",
    required: ["items", "total", "page", "pageSize", "permissions"],
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/ReceiptProcessingLine" },
      },
      total: { type: "integer" },
      page: { type: "integer" },
      pageSize: { type: "integer" },
      permissions: {
        type: "object",
        properties: {
          receive: { type: "boolean" },
          documents: { type: "boolean" },
        },
      },
    },
  },
  ReceiptOperatorControlResult: {
    type: "object",
    required: ["controlId", "decisionId", "nonConformityId", "verdict", "released", "held", "unit"],
    properties: {
      controlId: uuid, decisionId: uuid, nonConformityId: { ...uuid, nullable: true },
      verdict: { type: "string", enum: ["CONFORME", "NON_CONFORME"] }, released: quantity, held: quantity, unit: { type: "string" },
    },
  },
};
const payloads: Record<string, ObjectSchema> = {
  "operator-control": {
    kind: { type: "string", enum: ["MP"] },
    verdict: { type: "string", enum: ["CONFORME", "NON_CONFORME"] },
    measurements: { type: "array", minItems: 1, maxItems: 30, items: {
      type: "object", additionalProperties: false, required: ["label", "valueMm", "confirmed"], properties: {
        label: { type: "string", minLength: 1, maxLength: 120 },
        valueMm: { ...positive, maximum: 1000000000, multipleOf: 0.001 },
        confirmed: { type: "boolean", enum: [true] },
        result: { type: "string", enum: ["OK", "NOK"] },
      },
    } },
  },
  pack: {
    quantity: { ...positive, multipleOf: 0.000001 },
    packaging: { type: "string", minLength: 1, maxLength: 200 },
    packageCount: { type: "integer", minimum: 1, maximum: 100000 },
  },
  stock: {
    quantity: positive,
    magasinId: uuid,
    emplacementId: { type: "integer", minimum: 1 },
  },
  "tool-stock": { quantity: positive },
  "stock-article": { stockArticleId: uuid },
  "reconcile-processing": {
    reason: { type: "string", minLength: 3, maxLength: 2000 },
  },
  "void-packaging": {
    packagingId: uuid,
    reason: { type: "string", minLength: 3, maxLength: 2000 },
  },
  "subcontract-origins": {
    origins: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: ["issueEventId", "quantity"],
        properties: { issueEventId: uuid, quantity: positive },
      },
    },
  },
};
export function receiptProcessingOperation(
  key: string,
  operation: ObjectSchema,
): ObjectSchema {
  const operatorControl = key === "post /receptions/{id}/lines/{lineId}/operator-control";
  const base = "(?:/receptions|/terminals/reception)",
    action = operatorControl ? "operator-control" : key.match(
      new RegExp(
        `^post ${base}/\\{id\\}/lines/\\{lineId\\}/(${RECEIPT_PROCESSING_ACTIONS.join("|")})$`,
      ),
    )?.[1];
  const queue = new RegExp(`^get ${base}/processing$`).test(key),
    detail = new RegExp(
      `^get ${base}/\\{id\\}/lines/\\{lineId\\}/processing$`,
    ).test(key);
  if (!action && !queue && !detail) return operation;
  const response = {
    description: operatorControl ? "Contrôle opérateur enregistré ; la mise en stock reste distincte." : queue
      ? "Quantités par étape et droits du compte courant."
      : "État courant de la ligne ; aucune mise en stock automatique après emballage.",
    content: {
      "application/json": {
        schema: {
          $ref: `#/components/schemas/${operatorControl ? "ReceiptOperatorControlResult" : queue ? "ReceiptProcessingQueue" : "ReceiptProcessingLine"}`,
        },
      },
    },
  };
  const output = {
    ...operation,
    responses: {
      ...(operation.responses as ObjectSchema),
      "200": response,
      "404": { description: "Réception, ligne ou étiquette introuvable." },
      ...(operatorControl ? {
        "400": { description: "Identifiant de réception ou de ligne invalide." },
        "403": { description: "Droits de réception manquants ou session d’un terminal spécialisé." },
        "422": { description: "Mesures, confirmations ou résultat du contrôle invalides." },
      } : {}),
    },
  };
  if (queue)
    return {
      ...output,
      parameters: [
        {
          name: "q",
          in: "query",
          schema: { type: "string", maxLength: 160 },
          description:
            "Recherche ou étiquette CERP active (article, lot, commande, OF).",
        },
        {
          name: "stage",
          in: "query",
          schema: { type: "string", enum: stages },
        },
        {
          name: "page",
          in: "query",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "pageSize",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        },
      ],
    };
  if (!action) return output;
  return {
    ...output,
    "x-cerp-idempotency": "required-body-key",
    description:
      "Commande transactionnelle. Réutiliser idempotencyKey après perte réseau. expectedVersion impose une relecture si une autre action a modifié la ligne. Les droits, la qualité, l’emballage et la destination sont contrôlés sur le serveur.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "idempotencyKey",
              "expectedVersion",
              ...Object.keys(payloads[action]),
            ],
            properties: {
              idempotencyKey: uuid,
              expectedVersion: { type: "integer", minimum: 1 },
              ...payloads[action],
              ...(action === 'stock' ? { materialBars } : {}),
              ...(action === "pack"
                ? { notes: { type: "string", maxLength: 2000, nullable: true } }
                : {}),
              ...(action === "subcontract-origins"
                ? { returnEventId: uuid }
                : {}),
              ...(operatorControl ? {
                grade: { type: "object", additionalProperties: false, required: ["value", "confirmed"],
                  description: "Nuance observée, requise lorsqu’une référence est connue.", properties: {
                    value: { type: "string", minLength: 1, maxLength: 120 }, confirmed: { type: "boolean", enum: [true] },
                  } },
                note: { type: "string", maxLength: 2000, description: "Motif obligatoire pour un constat non conforme." },
              } : {}),
            },
          },
        },
      },
    },
  };
}
