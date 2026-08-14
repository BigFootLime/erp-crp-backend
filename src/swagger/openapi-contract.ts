import crypto from "node:crypto";

import {
  GENERATED_ROUTE_INVENTORY,
  GENERATED_ROUTE_SOURCE_SHA256,
  type GeneratedRouteContract,
} from "./generated-route-inventory";

type OpenApiObject = Record<string, unknown>;
type OpenApiOperation = Record<string, unknown>;
type OpenApiPathItem = Record<string, OpenApiOperation>;

const PUBLIC_ROUTE_POLICIES: Readonly<Record<string, string>> = {
  "post /auth/activate": "Activation par jeton administratif à usage unique avec limitation de débit.",
  "post /auth/forgot-password": "Demande de récupération non révélatrice avec limitation de débit.",
  "post /auth/login": "Échange d’identifiants contre une session avec limitation de débit distribuée.",
  "post /auth/reset-password": "Réinitialisation par jeton à usage unique avec limitation de débit.",
  "post /electronic-invoicing/webhooks/{providerCode}": "Webhook prestataire authentifié par signature sur le corps brut et limité en débit.",
  "get /environment": "Signal public minimal de routage de base, sans secret ni donnée métier.",
  "get /openapi.json": "Contrat public de la version API déployée.",
  "get /realtime/readiness": "Signal public booléen de disponibilité temps réel, sans détail d’infrastructure.",
};

const IDEMPOTENT_OPERATIONS = new Set([
  "post /admin/webhooks/subscriptions",
  "patch /admin/webhooks/subscriptions/{id}",
  "post /admin/webhooks/subscriptions/{id}/rotate-secret",
  "post /admin/webhooks/subscriptions/{id}/test",
  "post /admin/webhooks/deliveries/{id}/replay",
]);

function operationKey(route: GeneratedRouteContract): string {
  return `${route.method} ${route.path}`;
}

function operationId(route: GeneratedRouteContract): string {
  const suffix = route.path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => next?.toUpperCase() ?? ""))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${route.method}${suffix || "ApiRoot"}`;
}

function tagFor(route: GeneratedRouteContract): string {
  return route.path.split("/").filter(Boolean)[0] ?? "system";
}

function pathParameters(route: GeneratedRouteContract): OpenApiObject[] {
  return [...route.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
  }));
}

function genericResponses(route: GeneratedRouteContract): OpenApiObject {
  const responses: OpenApiObject = {
    "200": {
      description: "Réponse conforme au contrat de l’opération.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiResponse" } } },
    },
    "400": { $ref: "#/components/responses/BadRequest" },
    "429": { $ref: "#/components/responses/RateLimited" },
    "500": { $ref: "#/components/responses/InternalError" },
  };
  if (route.authenticated) {
    responses["401"] = { $ref: "#/components/responses/Unauthenticated" };
    responses["403"] = { $ref: "#/components/responses/Forbidden" };
  }
  if (route.method === "post") responses["201"] = responses["200"];
  if (["post", "put", "patch", "delete"].includes(route.method)) {
    responses["409"] = { $ref: "#/components/responses/Conflict" };
    responses["422"] = { $ref: "#/components/responses/Unprocessable" };
  }
  return responses;
}

function generatedOperation(route: GeneratedRouteContract): OpenApiOperation {
  const key = operationKey(route);
  const publicReason = PUBLIC_ROUTE_POLICIES[key];
  const providerSigned = key === "post /electronic-invoicing/webhooks/{providerCode}";
  const idempotent = IDEMPOTENT_OPERATIONS.has(key);
  const parameters = pathParameters(route);
  if (idempotent) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  const operation: OpenApiOperation = {
    tags: [tagFor(route)],
    summary: `${route.method.toUpperCase()} ${route.path}`,
    operationId: operationId(route),
    parameters,
    responses: genericResponses(route),
    security: route.authenticated
      ? [{ bearerAuth: [] }]
      : providerSigned
        ? [{ providerSignature: [] }]
        : [],
    "x-cerp-source": route.source,
    "x-cerp-authentication": route.authenticated ? "JWT Bearer + compte actif" : providerSigned ? "signature prestataire" : "public contrôlé",
    "x-cerp-rbac": route.rbac.length > 0 ? [...route.rbac] : route.authenticated ? ["moduleAccessGate"] : [],
    "x-cerp-rate-limit-policy": route.middleware.filter((name) => /RateLimit/i.test(name)),
    "x-cerp-idempotency": idempotent ? "required" : "not-declared",
    ...(publicReason ? { "x-cerp-public-reason": publicReason } : {}),
  };
  if (["post", "put", "patch"].includes(route.method)) {
    const multipart = route.middleware.some((name) => /\.single\(|\.array\(|\.fields\(/.test(name));
    operation.requestBody = {
      required: false,
      content: {
        [multipart ? "multipart/form-data" : "application/json"]: {
          schema: multipart
            ? { type: "object", additionalProperties: true }
            : { $ref: "#/components/schemas/ApiRequest" },
        },
      },
    };
  }
  return webhookOperation(key, operation);
}

function jsonSchemaResponse(description: string, schemaRef: string): OpenApiObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}

function webhookOperation(key: string, operation: OpenApiOperation): OpenApiOperation {
  const success = (operation.responses ?? {}) as OpenApiObject;
  const withErrors = (responses: OpenApiObject): OpenApiObject => ({
    ...responses,
    "400": success["400"],
    "401": success["401"],
    "403": success["403"],
    "409": success["409"],
    "422": success["422"],
    "429": success["429"],
    "500": success["500"],
  });
  if (key === "get /admin/webhooks/subscriptions") {
    return { ...operation, responses: withErrors({ "200": jsonSchemaResponse("Abonnements webhook.", "#/components/schemas/WebhookSubscriptionList") }) };
  }
  if (key === "get /admin/webhooks/subscriptions/{id}") {
    return { ...operation, responses: withErrors({ "200": jsonSchemaResponse("Abonnement webhook.", "#/components/schemas/WebhookSubscription") }) };
  }
  if (key === "post /admin/webhooks/subscriptions") {
    return {
      ...operation,
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookCreateRequest" } } } },
      responses: withErrors({
        "200": jsonSchemaResponse("Rejeu idempotent de la création.", "#/components/schemas/WebhookSecretResult"),
        "201": jsonSchemaResponse("Abonnement créé ; le secret n'est retourné qu'ici.", "#/components/schemas/WebhookSecretResult"),
      }),
    };
  }
  if (key === "patch /admin/webhooks/subscriptions/{id}") {
    return {
      ...operation,
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookPatchRequest" } } } },
      responses: withErrors({ "200": jsonSchemaResponse("Abonnement modifié.", "#/components/schemas/WebhookSubscriptionMutationResult") }),
    };
  }
  if (key === "post /admin/webhooks/subscriptions/{id}/rotate-secret") {
    return {
      ...operation,
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookRotateRequest" } } } },
      responses: withErrors({ "200": jsonSchemaResponse("Secret tourné ou résultat idempotent identique.", "#/components/schemas/WebhookSecretResult") }),
    };
  }
  if (key === "post /admin/webhooks/subscriptions/{id}/test" || key === "post /admin/webhooks/deliveries/{id}/replay") {
    return {
      ...operation,
      requestBody: undefined,
      responses: withErrors({
        "200": jsonSchemaResponse("Rejeu idempotent de la commande.", "#/components/schemas/WebhookDeliveryMutationResult"),
        "202": jsonSchemaResponse("Livraison mise en file.", "#/components/schemas/WebhookDeliveryMutationResult"),
      }),
    };
  }
  if (key === "get /admin/webhooks/deliveries") {
    return { ...operation, responses: withErrors({ "200": jsonSchemaResponse("Livraisons récentes.", "#/components/schemas/WebhookDeliveryList") }) };
  }
  return operation;
}

function legacyPathOperation(legacy: OpenApiObject, route: GeneratedRouteContract): OpenApiOperation | null {
  const paths = legacy.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return null;
  const pathItem = (paths as Record<string, unknown>)[route.path];
  if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) return null;
  const operation = (pathItem as Record<string, unknown>)[route.method];
  return operation && typeof operation === "object" && !Array.isArray(operation)
    ? operation as OpenApiOperation
    : null;
}

function componentSchemas(legacy: OpenApiObject): OpenApiObject {
  const components = legacy.components;
  const legacyComponents = components && typeof components === "object" && !Array.isArray(components)
    ? components as OpenApiObject
    : {};
  const legacySchemas = legacyComponents.schemas && typeof legacyComponents.schemas === "object" && !Array.isArray(legacyComponents.schemas)
    ? legacyComponents.schemas as OpenApiObject
    : {};
  return {
    ...legacyComponents,
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      providerSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Provider-Signature",
        description: "Nom indicatif : le nom exact et l’algorithme sont définis par l’adaptateur prestataire qualifié.",
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", format: "uuid" },
        description: "Clé UUID stable pour la commande et son retry. Une réutilisation avec un autre payload retourne 409.",
      },
      Limit: {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      Cursor: {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", maxLength: 512 },
      },
    },
    schemas: {
      ...legacySchemas,
      ApiRequest: {
        type: "object",
        additionalProperties: true,
        description: "Le schéma précis est porté par le validateur Zod du contrôleur référencé dans x-cerp-source.",
      },
      ApiResponse: {
        oneOf: [
          { type: "object", additionalProperties: true },
          { type: "array", items: {} },
          { type: "string" },
        ],
      },
      ErrorResponse: {
        type: "object",
        required: ["message"],
        properties: {
          success: { type: "boolean", enum: [false] },
          message: { type: "string" },
          code: { type: "string", nullable: true },
          path: { type: "string", nullable: true },
        },
        additionalProperties: true,
      },
      WebhookSubscription: {
        type: "object",
        required: ["id", "name", "endpoint_url", "event_types", "status", "secret_hint", "secret_version", "consecutive_failure_count", "disabled_reason", "created_at", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", minLength: 2, maxLength: 120 },
          endpoint_url: { type: "string", format: "uri", example: "https://receiver.example.invalid/cerp-events" },
          event_types: { type: "array", minItems: 1, items: { type: "string", example: "erp.invoice.issued.v1" } },
          status: { type: "string", enum: ["ACTIVE", "PAUSED", "DISABLED"] },
          secret_hint: { type: "string", description: "Huit derniers caractères, jamais le secret." },
          secret_version: { type: "integer", minimum: 1 },
          consecutive_failure_count: { type: "integer", minimum: 0 },
          disabled_reason: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      WebhookSubscriptionList: { type: "array", items: { $ref: "#/components/schemas/WebhookSubscription" } },
      WebhookCreateRequest: {
        type: "object",
        required: ["name", "endpoint_url", "event_types"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 120, example: "Connecteur comptable" },
          endpoint_url: { type: "string", format: "uri", example: "https://receiver.example.invalid/cerp-events" },
          event_types: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", example: "erp.invoice.issued.v1" } },
        },
        additionalProperties: false,
      },
      WebhookPatchRequest: {
        type: "object",
        required: ["expected_updated_at"],
        properties: {
          expected_updated_at: { type: "string", format: "date-time" },
          name: { type: "string", minLength: 2, maxLength: 120 },
          endpoint_url: { type: "string", format: "uri" },
          event_types: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
          status: { type: "string", enum: ["ACTIVE", "PAUSED", "DISABLED"] },
        },
        additionalProperties: false,
      },
      WebhookRotateRequest: {
        type: "object",
        required: ["expected_updated_at"],
        properties: { expected_updated_at: { type: "string", format: "date-time" } },
        additionalProperties: false,
      },
      WebhookSecretResult: {
        type: "object",
        required: ["subscription", "secret", "idempotent_replay"],
        properties: {
          subscription: { $ref: "#/components/schemas/WebhookSubscription" },
          secret: { type: "string", writeOnly: true, example: "whsec_<store-in-secret-manager>" },
          idempotent_replay: { type: "boolean" },
        },
        additionalProperties: false,
      },
      WebhookSubscriptionMutationResult: {
        type: "object",
        required: ["subscription", "idempotent_replay"],
        properties: {
          subscription: { $ref: "#/components/schemas/WebhookSubscription" },
          idempotent_replay: { type: "boolean" },
        },
        additionalProperties: false,
      },
      WebhookDelivery: {
        type: "object",
        required: ["id", "subscription_id", "event_id", "replay_of_delivery_id", "status", "attempt_count", "next_attempt_at", "last_http_status", "last_error_code", "delivered_at", "created_at", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          subscription_id: { type: "string", format: "uuid" },
          event_id: { type: "string", format: "uuid" },
          replay_of_delivery_id: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["PENDING", "PROCESSING", "RETRY", "DELIVERED", "DEAD_LETTER", "CANCELLED"] },
          attempt_count: { type: "integer", minimum: 0, maximum: 8 },
          next_attempt_at: { type: "string", format: "date-time" },
          last_http_status: { type: "integer", minimum: 100, maximum: 599, nullable: true },
          last_error_code: { type: "string", nullable: true },
          delivered_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          event_type: { type: "string", example: "erp.invoice.issued.v1" },
        },
        additionalProperties: false,
      },
      WebhookDeliveryList: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } },
      WebhookDeliveryMutationResult: {
        type: "object",
        required: ["delivery", "idempotent_replay"],
        properties: {
          delivery: { $ref: "#/components/schemas/WebhookDelivery" },
          idempotent_replay: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    responses: {
      BadRequest: { description: "Entrée invalide.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      Unauthenticated: { description: "Authentification absente ou expirée." },
      Forbidden: { description: "Compte, module, rôle ou capacité insuffisant." },
      Conflict: { description: "Conflit de version, de transition ou d’idempotence." },
      Unprocessable: { description: "Précondition métier non satisfaite." },
      RateLimited: { description: "Limite de débit atteinte ; respecter Retry-After." },
      InternalError: { description: "Erreur interne corrélée par X-Request-Id." },
    },
  };
}

export function assertOpenApiRouteSecurity(): void {
  const undocumentedPublic = GENERATED_ROUTE_INVENTORY
    .filter((route) => !route.authenticated && !PUBLIC_ROUTE_POLICIES[operationKey(route)])
    .map((route) => operationKey(route));
  if (undocumentedPublic.length > 0) {
    throw new Error(`OPENAPI_PUBLIC_ROUTE_POLICY_MISSING:${undocumentedPublic.join(",")}`);
  }
  const stalePolicies = Object.keys(PUBLIC_ROUTE_POLICIES).filter((key) =>
    !GENERATED_ROUTE_INVENTORY.some((route) => operationKey(route) === key)
  );
  if (stalePolicies.length > 0) throw new Error(`OPENAPI_PUBLIC_ROUTE_POLICY_STALE:${stalePolicies.join(",")}`);
}

export function buildOpenApiDocument(legacy: OpenApiObject = {}): OpenApiObject {
  assertOpenApiRouteSecurity();
  const paths: Record<string, OpenApiPathItem> = {};
  for (const route of GENERATED_ROUTE_INVENTORY) {
    const generated = generatedOperation(route);
    const detailed = legacyPathOperation(legacy, route);
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = detailed
      ? {
          ...generated,
          ...detailed,
          security: generated.security,
          "x-cerp-source": generated["x-cerp-source"],
          "x-cerp-authentication": generated["x-cerp-authentication"],
          "x-cerp-rbac": generated["x-cerp-rbac"],
          "x-cerp-public-reason": generated["x-cerp-public-reason"],
        }
      : generated;
    paths[route.path] = pathItem;
  }
  const deployedVersion = process.env.CERP_RELEASE_VERSION?.trim() || "development";
  return {
    openapi: "3.0.3",
    info: {
      title: "CERP+ API",
      version: deployedVersion,
      description: "Contrat API v1 généré depuis les routeurs Express. Les schémas détaillés complètent progressivement l’inventaire structurel sans masquer les opérations existantes.",
      "x-cerp-source-sha256": GENERATED_ROUTE_SOURCE_SHA256,
      "x-cerp-deprecation-policy": "Préavis documenté de 180 jours minimum ; en-têtes Deprecation et Sunset ; maintien dans /api/v1 pendant la fenêtre annoncée.",
    },
    servers: [{ url: "/api/v1", description: "Même hôte, API v1" }],
    tags: [...new Set(GENERATED_ROUTE_INVENTORY.map(tagFor))].sort().map((name) => ({ name })),
    components: componentSchemas(legacy),
    paths,
    "x-cerp-route-coverage": {
      scope: "/api/v1",
      discovered: GENERATED_ROUTE_INVENTORY.length,
      documented: GENERATED_ROUTE_INVENTORY.length,
      percent: 100,
      source_sha256: GENERATED_ROUTE_SOURCE_SHA256,
    },
    "x-cerp-contract-digest": crypto.createHash("sha256")
      .update(`${GENERATED_ROUTE_SOURCE_SHA256}:${deployedVersion}`)
      .digest("hex"),
  };
}

export function openApiContractDigest(document: OpenApiObject): string {
  return crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex");
}
