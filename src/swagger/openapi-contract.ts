import crypto from "node:crypto";
import { ASSIGNABLE_USER_ROLES, PRIMARY_USER_ROLES } from "../module/auth/domain/roles";
import { deliveryAffairsOperation, deliveryAffairsSchemas } from "./delivery-affairs-contract";
import { proformaOperation, proformaSchemas } from "./proforma-contract";
import {RECEIPT_PROCESSING_ACTIONS,receiptProcessingOperation,receiptProcessingSchemas} from "./receipt-processing-contract";
import { clientCrmOperation, clientCrmSchemas } from "./client-crm-contract";
import { clientContractOperation, clientContractSchemas } from "./client-contract-contract";
import { clientContractLegacyOperation, clientContractLegacySchemas } from "./client-contract-legacy-contract";
import { clientContractForecastOperation, clientContractForecastSchemas } from "./client-contract-forecast-contract";
import { clientContractReplenishmentOperation, clientContractReplenishmentSchemas } from "./client-contract-replenishment-contract";
import { assemblyComponentOperation, assemblyComponentSchemas } from './assembly-component-contract';
import { terminalAssemblyOperation, TERMINAL_ASSEMBLY_OPERATIONS } from './terminal-assembly-contract';
import { stockValuationOperation } from './stock-valuation-contract';
import { stockValueAdjustmentOperation } from './stock-value-adjustment-contract';
import { supplierInvoiceHeaderOperation } from './supplier-invoice-header-contract';
import { materialInvoiceReconciliationOperation } from './material-invoice-reconciliation-contract';
import { supplierRecommendationOperation } from './supplier-recommendation-contract';
import { stockLanesOperation } from './stock-lanes-contract';
import { productionReceiptLanesOperation } from './production-receipt-lanes-contract';
import { manufacturingCostBasisOperation } from './manufacturing-cost-basis-contract';
import { assemblyComponentReturnOperation, assemblyComponentReturnSchemas } from './assembly-component-return-contract';

import {
  GENERATED_ROUTE_INVENTORY,
  GENERATED_ROUTE_SOURCE_SHA256,
  type GeneratedRouteContract,
} from "./generated-route-inventory";

type OpenApiObject = Record<string, unknown>;
type OpenApiOperation = Record<string, unknown>;
type OpenApiPathItem = Record<string, OpenApiOperation>;

const PUBLIC_ROUTE_POLICIES: Readonly<Record<string, string>> = {
  "post /intercompany/messages": "Transport entre entreprises authentifié par HMAC-SHA256 avec clé propre au pair, empreinte du message canonique, cible/environnement fixes, horodatage de 60 secondes et nonce ; traitement transactionnel de l’inbox et rejeu idempotent par identifiant et empreinte. Aucun jeton utilisateur n’est accepté comme preuve du pair.",
  "get /entreprises/sign-in-context": "Contexte minimal de connexion d'une instance entreprise active. La cible et l'environnement doivent correspondre au runtime fixe ; aucune liste d'entreprises, session ou donnée privée n'est exposée.",
  "post /entreprises/switches/exchange": "Ticket opaque de changement d'entreprise valable au plus 60 secondes, lié au profil, à la session source, à la cible et aux versions d'adhésion ; limitation IP/ticket persistée, aucun Bearer source accepté, consommation et émission de session idempotentes par la même clé.",
  "get /auth/test-registration": "Disponibilité du formulaire test, désactivé par défaut et limité à current_database()=cerp_test avec opt-in serveur.",
  "post /auth/test-registration": "Création test uniquement avec opt-in serveur, vérification de la base connectée, débit persisté, idempotence et MFA obligatoire avant première session.",
  "post /terminals/pair": "Appairage par secret temporaire aléatoire de 128 bits, à usage unique, valable quinze minutes et lié à un terminal enregistré.",
  "post /auth/activate": "Activation par jeton administratif à usage unique avec limitation de débit.",
  "post /auth/forgot-password": "Demande de récupération non révélatrice avec limitation de débit.",
  "post /auth/login": "Échange d’identifiants contre une session avec limitation de débit distribuée.",
  "post /auth/tablet-pin/login": "Connexion PIN limitée en débit, liée à un appareil Directory révocable par un secret aléatoire et verrouillée après des échecs répétés ; la MFA reste requise quand la politique du compte l’impose.",
  "post /auth/tablet-pin/pair": "Échange unique d’un code d’appairage aléatoire de 128 bits valable quinze minutes contre le secret d’une tablette neutre ; aucune identité ERP n’est exposée.",
  "post /auth/mfa/verify": "Vérification d’un challenge MFA signé, court, à usage unique et limité en débit avant émission de session.",
  "post /auth/reset-password": "Réinitialisation par jeton à usage unique avec limitation de débit.",
  "post /auth/account-requests": "Demande d'accès Production soumise sans session ERP, limitée par IP et par adresse e-mail ; aucun compte ni jeton n'est créé avant l'approbation SuperAdmin.",
  "get /auth/account-requests/status": "Suivi minimal d'une demande par reçu opaque présenté exclusivement dans l'en-tête Authorization ; aucune identité, rôle ou donnée du formulaire n'est exposé.",
  "post /electronic-invoicing/webhooks/{providerCode}": "Webhook prestataire authentifié par signature sur le corps brut et limité en débit.",
  "post /time-clock/device-events": "Ingestion de badge authentifiée par le token opaque aléatoire de 192 bits d’une borne active ; UID haché côté serveur et commande idempotente.",
  "post /time-clock/device-heartbeat": "Présence d’une borne authentifiée par son token opaque aléatoire de 192 bits ; aucune donnée RH n’est retournée.",
  "get /environment": "Signal public minimal de routage de base, sans secret ni donnée métier.",
  "get /openapi.json": "Contrat public de la version API déployée.",
  "get /realtime/readiness": "Signal public booléen de disponibilité temps réel, sans détail d’infrastructure.",
  "post /portal/auth/activate": "Activation par jeton portail à usage unique avec limitation de débit persistée.",
  "post /portal/auth/forgot-password": "Demande de récupération portail non révélatrice avec limitation de débit persistée.",
  "post /portal/auth/login": "Échange d’identifiants portail contre une session courte avec limitation de débit persistée.",
  "post /portal/auth/reset-password": "Réinitialisation portail par jeton à usage unique avec limitation de débit persistée.",
};

const CLIENT_PORTAL_AUTH_OPERATIONS = new Set([
  "get /portal/deliveries",
  "get /portal/documents",
  "post /portal/documents/{publicationId}/acknowledgements",
  "get /portal/documents/{publicationId}/download",
  "get /portal/invoices",
  "get /portal/me",
  "get /portal/orders",
]);

const IDEMPOTENT_OPERATIONS = new Set([
  "post /admin/webhooks/subscriptions",
  "patch /admin/webhooks/subscriptions/{id}",
  "post /admin/webhooks/subscriptions/{id}/rotate-secret",
  "post /admin/webhooks/subscriptions/{id}/test",
  "post /admin/webhooks/deliveries/{id}/replay",
]);

const TERMINAL_DEVICE_OPERATIONS = new Set(["get /terminals/bootstrap", "post /terminals/identify"]);
const TERMINAL_SESSION_OPERATIONS = new Set([
  ...TERMINAL_ASSEMBLY_OPERATIONS,
  "get /terminals/cutting/worklist", "post /terminals/cutting/resolve-of",
  "get /terminals/cutting/ofs/{of_id}/operations/{operation_id}",
  "get /terminals/cutting/ofs/{of_id}/operations/{operation_id}/documents/{id}",
  "post /terminals/cutting/ofs/{of_id}/operations/{operation_id}/scan",
  "post /terminals/cutting/ofs/{of_id}/operations/{operation_id}/debits",
  "post /terminals/cutting/ofs/{of_id}/operations/{operation_id}/execution",
  "get /terminals/cutting/ofs/{of_id}/operations/{operation_id}/client-logo",
  "get /terminals/cutting/ofs/{of_id}/operations/{operation_id}/client-logo/content",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}/client-logo",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}/client-logo/content",
  "get /terminals/reception/processing","get /terminals/reception/{id}/lines/{lineId}/processing","get /terminals/reception/mp-articles",
  "get /terminals/reception/{id}/documents/{docId}/download",
  ...RECEIPT_PROCESSING_ACTIONS.map(action=>`post /terminals/reception/{id}/lines/{lineId}/${action}`),
  "post /terminals/reception/{id}/lines/{lineId}/stock-receipt","post /terminals/reception/{id}/lines/{lineId}/create-lot",
  "get /terminals/reception/quality/executions/{id}","get /terminals/reception/quality/instruments",
  "post /terminals/reception/quality/executions/preview","post /terminals/reception/quality/executions",
  "post /terminals/reception/quality/executions/{id}/measurements","get /terminals/reception/quality/executions/{id}/verdict-preview","post /terminals/reception/quality/executions/{id}/decision",
  "get /terminals/logistics/article-categories", "get /terminals/logistics/magasins", "get /terminals/logistics/emplacements",
  "get /terminals/reception/expected-lines", "get /terminals/reception/drafts", "get /terminals/reception/scan",
  "post /terminals/reception/grouped", "get /terminals/reception/{id}",
  "post /terminals/reception/{id}/confirm", "post /terminals/reception/{id}/documents",
  "get /terminals/procurement/ofs", "get /terminals/procurement/ofs/{id}",
  "post /terminals/procurement/ofs/{id}/configure", "post /terminals/procurement/ofs/{id}/prepare",
  "post /terminals/procurement/ofs/{id}/withdraw", "post /terminals/procurement/ofs/{id}/reconcile",
  "get /terminals/procurement/consumables/resolve", "get /terminals/procurement/consumables/{id}/supply",
  "post /terminals/procurement/consumables/{id}/replenish", "post /terminals/procurement/consumables/{id}/finish-pack",
  "get /terminals/session", "post /terminals/session/activity", "post /terminals/session/lock", "post /terminals/session/close",
  "get /terminals/operator/worklist", "get /terminals/operator/activities", "post /terminals/operator/scan",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}/documents/{id}",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/handover",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/program/confirm",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/start",
  "post /terminals/operator/executions/{id}/{action}",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/declaration/preview",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/declaration/confirm",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{action}",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{id}/measurements",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{id}/autocontrol-capture",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{id}/paper-documents",
  "post /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{id}/paper-documents",
  "get /terminals/operator/ofs/{of_id}/operations/{operation_id}/controls/{id}/paper-documents/{docId}/file",
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

function genericResponses(route: GeneratedRouteContract, authenticated = route.authenticated): OpenApiObject {
  const responses: OpenApiObject = {
    "200": {
      description: "Réponse conforme au contrat de l’opération.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiResponse" } } },
    },
    "400": { $ref: "#/components/responses/BadRequest" },
    "429": { $ref: "#/components/responses/RateLimited" },
    "500": { $ref: "#/components/responses/InternalError" },
  };
  if (authenticated) {
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
  const intercompanySigned = key === "post /intercompany/messages";
  const clientPortalAuthenticated = CLIENT_PORTAL_AUTH_OPERATIONS.has(key);
  const terminalSession = TERMINAL_SESSION_OPERATIONS.has(key);
  const terminalDevice = TERMINAL_DEVICE_OPERATIONS.has(key) || terminalSession;
  const idempotent = IDEMPOTENT_OPERATIONS.has(key);
  const parameters = pathParameters(route);
  if (intercompanySigned) {
    for (const suffix of ["Source", "Destination", "Environment", "Time", "Nonce"]) {
      parameters.push({ name: `X-CERP-Intercompany-${suffix}`, in: "header", required: true, schema: { type: "string" } });
    }
  }
  if (idempotent) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  const operation: OpenApiOperation = {
    tags: [tagFor(route)],
    summary: `${route.method.toUpperCase()} ${route.path}`,
    operationId: operationId(route),
    parameters,
    responses: genericResponses(route, route.authenticated || clientPortalAuthenticated || terminalDevice || intercompanySigned),
    security: terminalSession ? [{terminalDevice:[], terminalSession:[]}]
      : terminalDevice ? [{terminalDevice:[]}]
      : intercompanySigned ? [{intercompanySignature:[]}]
      : route.authenticated
      ? [{ bearerAuth: [] }]
      : clientPortalAuthenticated
        ? [{ clientPortalBearerAuth: [] }]
      : providerSigned
        ? [{ providerSignature: [] }]
        : [],
    "x-cerp-source": route.source,
    "x-cerp-authentication": terminalSession ? "Appareil appairé + session PIN active liée à cet appareil + compte et droits vérifiés"
      : terminalDevice ? "Secret d’appareil appairé et non révoqué"
      : intercompanySigned ? "HMAC-SHA256 du pair + message canonique + cible/environnement fixes + fenêtre de 60 secondes"
      : route.authenticated
      ? "JWT Bearer + compte actif"
      : clientPortalAuthenticated
        ? "JWT Bearer portail + compte client actif + session_epoch"
        : providerSigned
          ? "signature prestataire"
          : "public contrôlé",
    "x-cerp-rbac": intercompanySigned ? ["configuredPeerScope", "fixedCompanyEnvironmentScope", "transactionalInboxIdentity"]
      : terminalDevice ? ["terminalDeviceScope", ...(terminalSession ? ["terminalSessionScope", "terminalKindScope"] : [])]
      : route.rbac.length > 0
      ? [...route.rbac]
      : route.authenticated
        ? ["moduleAccessGate"]
        : clientPortalAuthenticated
          ? ["clientPortalTenantBoundary"]
          : [],
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
  if (route.path.startsWith("/entreprises")) return companyOperation(key, operation);
  const enriched = supplierRecommendationOperation(key,materialInvoiceReconciliationOperation(key,supplierInvoiceHeaderOperation(key,stockValueAdjustmentOperation(key, manufacturingCostBasisOperation(key, stockValuationOperation(key, terminalAssemblyOperation(key, assemblyComponentReturnOperation(key, assemblyComponentOperation(key, clientCrmOperation(key, receiptProcessingOperation(key,webhookOperation(key, operation))))))))))));
  return accountRequestOperation(key, proformaOperation(key,clientContractReplenishmentOperation(key, clientContractForecastOperation(key, clientContractLegacyOperation(key, deliveryAffairsOperation(key, clientContractOperation(key, productionReceiptLanesOperation(key, stockLanesOperation(key, enriched)))))))));
}

function companyOperation(key: string, operation: OpenApiOperation): OpenApiOperation {
  const signInContext = key === "get /entreprises/sign-in-context";
  const exchange = key === "post /entreprises/switches/exchange";
  const createSwitch = key === "post /entreprises/switches";
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const result: OpenApiOperation = {
    ...operation,
    tags: ["entreprises"],
    parameters: [...parameters,
      { name: "X-CERP-Company", in: "header", required: exchange, schema: { type: "string", format: "uuid" }, description: "Entreprise active, recoupée avec le runtime fixe et l'adhésion Directory. Requise sur les requêtes protégées en mode multi-entreprises, facultative pour la découverte initiale." },
      { name: "X-CERP-Database", in: "header", required: exchange, schema: { type: "string", enum: ["cerp_prod", "cerp_test"] }, description: "Environnement indépendant de l'entreprise ; jamais une URL ou une connexion SQL." },
    ],
    "x-cerp-rbac": signInContext ? ["fixedCompanyRuntime", "activeCompanyInstance"] : exchange ? ["shortLivedCompanySwitchTicket", "fixedCompanyRuntime", "liveSourceAndTargetMembership"] : key.includes("/admin/") ? ["liveDirectoryOwner", "recentMfa", "fixedCompanyRuntime"] : ["liveDirectorySession", "activeCompanyMembership", "fixedCompanyRuntime"],
    responses: { ...operation.responses as OpenApiObject, ...(signInContext ? {} : { "401": { $ref: "#/components/responses/Unauthenticated" } }), "403": { $ref: "#/components/responses/Forbidden" }, "503": { description: "Annuaire, contexte entreprise ou instance non disponible ; aucun repli vers une autre entreprise." } },
  };
  if (exchange || createSwitch) result.requestBody = {
    required: true,
    content: { "application/json": { schema: {
      type: "object", additionalProperties: false,
      required: exchange ? ["ticket", "key"] : ["target_company_id", "key"],
      properties: { key: { type: "string", format: "uuid", description: "Conserver la même clé lors d'un réessai après une réponse réseau ambiguë." }, ...(exchange ? { ticket: { type: "string", pattern: "^[a-f0-9]{64}$" } } : { target_company_id: { type: "string", format: "uuid" } }) },
    } } },
  };
  if (exchange) result["x-cerp-authentication"] = "Ticket opaque à cible fixe, sans en-tête Authorization source";
  if (signInContext) result["x-cerp-authentication"] = "Public : l'instance fixe confirme uniquement sa propre société active ; les en-têtes de cible sont facultatifs et, s'ils sont fournis, doivent correspondre au runtime.";
  if (exchange || createSwitch) result["x-cerp-idempotency"] = "required-body-key";
  return result;
}

function accountRequestOperation(key: string, operation: OpenApiOperation): OpenApiOperation {
  const existingParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const productionDatabase = {
    name: "X-CERP-Database",
    in: "header",
    required: true,
    schema: { type: "string", enum: ["cerp_prod"] },
    description: "La demande et son suivi sont exclusivement rattachés au site Production.",
  };
  if (key === "post /auth/account-requests") {
    return {
      ...operation,
      parameters: [...existingParameters, productionDatabase],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AccountRequestSubmit" } } } },
      responses: {
        ...operation.responses as OpenApiObject,
        "202": jsonSchemaResponse("Demande placée en attente ; conserver le reçu opaque hors ligne.", "#/components/schemas/AccountRequestReceipt"),
      },
    };
  }
  if (key === "get /auth/account-requests/status") {
    return {
      ...operation,
      parameters: [...existingParameters, productionDatabase, {
        name: "Authorization",
        in: "header",
        required: true,
        schema: { type: "string", pattern: "^Account-Request-Receipt [A-Za-z0-9_-]{43}$" },
        description: "Reçu opaque retourné lors de la soumission. Ce n'est pas un jeton Bearer ni une session ERP.",
      }],
      responses: { ...operation.responses as OpenApiObject, "200": jsonSchemaResponse("État minimal de la demande.", "#/components/schemas/AccountRequestStatus") },
    };
  }
  if (key === "get /admin/account-requests") {
    return { ...operation, responses: { ...operation.responses as OpenApiObject, "200": jsonSchemaResponse("Demandes administrables non expurgées.", "#/components/schemas/AccountRequestList") } };
  }
  if (key === "post /admin/account-requests/{id}/approve") {
    return {
      ...operation,
      parameters: [...existingParameters, { $ref: "#/components/parameters/IdempotencyKey" }],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AccountRequestApproval" } } } },
      responses: { ...operation.responses as OpenApiObject, "201": jsonSchemaResponse("Approbation et activation locale terminées, ou résultat terminal d'un rejeu.", "#/components/schemas/AccountRequestDecision") },
    };
  }
  if (key === "post /admin/account-requests/{id}/reject" || key === "delete /admin/account-requests/{id}") {
    return { ...operation, parameters: [...existingParameters, { $ref: "#/components/parameters/IdempotencyKey" }] };
  }
  return operation;
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
      intercompanySignature: { type: "apiKey", in: "header", name: "X-CERP-Intercompany-Signature", description: "HMAC-SHA256 hexadécimal du cadre signé incluant méthode, chemin, entreprises, environnement, horodatage, nonce et empreinte canonique. Les autres en-têtes X-CERP-Intercompany sont obligatoires." },
      terminalDevice: {type:"apiKey",in:"header",name:"X-Terminal-Device",description:"Secret aléatoire du terminal appairé."},
      terminalSession: {type:"apiKey",in:"header",name:"X-Station-Session",description:"Jeton opérateur en mémoire, lié au terminal."},
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      clientPortalBearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Jeton de session court du portail client, audience cerp-client-portal.",
      },
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
      ...receiptProcessingSchemas,
      ...clientCrmSchemas,
      ...clientContractSchemas,
      ...clientContractLegacySchemas,
      ...clientContractForecastSchemas,
      ...clientContractReplenishmentSchemas,
      ...deliveryAffairsSchemas,
      ...proformaSchemas,
      ...assemblyComponentSchemas,
      ...assemblyComponentReturnSchemas,
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
      AccountRequestSubmit: {
        type: "object",
        required: ["name", "surname", "email", "password", "avatar_key"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80, description: "Nom." },
          surname: { type: "string", minLength: 2, maxLength: 80, description: "Prénom ; le serveur dérive l'identifiant immuable lors de l'approbation." },
          email: { type: "string", format: "email" },
          password: { type: "string", format: "password", minLength: 10, maxLength: 72, writeOnly: true },
          avatar_key: { type: "string", description: "Clé d'avatar prédéfinie ; aucun fichier n'est accepté avant authentification." },
        },
        additionalProperties: false,
      },
      AccountRequestReceipt: {
        type: "object",
        required: ["request_id", "status", "receipt"],
        properties: {
          request_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["PENDING"] },
          receipt: { type: "string", readOnly: true, pattern: "^[A-Za-z0-9_-]{43}$", description: "Affiché une seule fois ; le serveur ne conserve que son empreinte." },
        },
        additionalProperties: false,
      },
      AccountRequestStatus: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["PENDING", "PROJECTION_PENDING", "APPROVED", "REJECTED", "EXPIRED"] },
          username: { type: "string", nullable: true, description: "Présent seulement après approbation." },
        },
        additionalProperties: false,
      },
      AccountRequestApproval: {
        type: "object",
        required: ["expected_version", "primary_role", "roles", "administrative_kind", "module_keys"],
        properties: {
          expected_version: { type: "integer", minimum: 0 },
          primary_role: { type: "string", enum: [...PRIMARY_USER_ROLES] },
          roles: { type: "array", minItems: 1, maxItems: ASSIGNABLE_USER_ROLES.length, items: { type: "string", enum: [...ASSIGNABLE_USER_ROLES] }, description: "Toutes les fonctions du catalogue peuvent être cumulées." },
          administrative_kind: { type: "string", enum: ["STANDARD", "BUSINESS_ADMIN"] },
          module_keys: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9-]+$" } },
          link_historical_user_id: { type: "integer", minimum: 1, nullable: true, description: "Réservé à une opération propriétaire distincte ; la route retourne 422 si fourni." },
        },
        additionalProperties: false,
      },
      AccountRequestDecision: {
        type: "object",
        required: ["request_id", "status", "username"],
        properties: {
          request_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["APPROVED"] },
          username: { type: "string" },
        },
        additionalProperties: true,
      },
      AccountRequestList: {
        type: "object",
        required: ["requests", "next_cursor", "historical_link_supported"],
        properties: {
          requests: { type: "array", items: { type: "object", additionalProperties: true } },
          next_cursor: { type: "string", format: "uuid", nullable: true },
          historical_link_supported: { type: "boolean", enum: [false] },
        },
        additionalProperties: false,
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
    .filter((route) => !route.authenticated
      && !TERMINAL_DEVICE_OPERATIONS.has(operationKey(route))
      && !TERMINAL_SESSION_OPERATIONS.has(operationKey(route))
      && !CLIENT_PORTAL_AUTH_OPERATIONS.has(operationKey(route))
      && !PUBLIC_ROUTE_POLICIES[operationKey(route)])
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
