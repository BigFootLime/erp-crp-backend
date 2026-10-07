import { CRM_CHANNELS, CRM_CONTACT_POLICIES, CRM_CUSTOMER_KINDS, CRM_OUTCOMES,
  CRM_PURPOSES, CRM_RESCHEDULE_REASONS, CRM_STAGES } from "../module/client/types/client-crm.types";

type Schema = Record<string, unknown>;
const uuid = { type: "string", format: "uuid" }, timestamp = { type: "string", format: "date-time" };
const clientId = { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" };
const userId = { type: "integer", minimum: 1, maximum: 2147483647 };
const version = { type: "integer", minimum: 1, maximum: 2147483646 };
const textEnum = (values: readonly string[]) => ({ type: "string", enum: [...values] });
const nullable = (schema: Schema) => ({ ...schema, nullable: true });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const page = (item: string) => object({ items: { type: "array", maxItems: 100, items: ref(item) }, total: { type: "integer", minimum: 0 },
  page: { type: "integer", minimum: 1 }, page_size: { type: "integer", minimum: 1, maximum: 100 } });
const note = nullable({ type: "string", maxLength: 2000 });
const existing = { followup_id: uuid, expected_version: version };
const command = (action: string, properties: Record<string, Schema>) => object({ action: textEnum([action]), ...properties });

export const clientCrmSchemas: Record<string, Schema> = {
  ClientCrmProfile: object({ client_id: clientId, customer_kind: textEnum(CRM_CUSTOMER_KINDS), stage: textEnum(CRM_STAGES),
    owner_user_id: nullable(userId), contact_policy: textEnum(CRM_CONTACT_POLICIES), retention_review_date: nullable({ type: "string", format: "date" }),
    version: { ...version, minimum: 0 }, updated_at: nullable(timestamp) }),
  ClientCrmFollowup: object({ id: uuid, client_id: clientId, client_code: nullable({ type: "string" }), company_name: { type: "string" },
    contact_id: nullable(uuid), contact_label: nullable({ type: "string" }), owner_user_id: userId, owner_label: { type: "string" },
    contact_policy: textEnum(CRM_CONTACT_POLICIES), client_active: { type: "boolean" }, channel: textEnum(CRM_CHANNELS), purpose: textEnum(CRM_PURPOSES),
    title: nullable({ type: "string", minLength: 3, maxLength: 160 }), due_at: timestamp, status: textEnum(["PLANNED", "COMPLETED", "CANCELLED"]),
    outcome: nullable(textEnum(CRM_OUTCOMES)), result_note: note, completed_at: nullable(timestamp), version, created_at: timestamp }),
  ClientCrmEvent: object({ id: uuid, client_id: clientId, followup_id: nullable(uuid), action: textEnum(["QUALIFY", "PLAN", "RESCHEDULE", "COMPLETE", "CANCEL", "LOG_INTERACTION"]),
    actor_user_id: userId, actor_label: { type: "string" }, occurred_at: timestamp, details: { type: "object", additionalProperties: true } }),
  ClientCrmFollowupPage: page("ClientCrmFollowup"), ClientCrmEventPage: page("ClientCrmEvent"),
  ClientCrmDetail: object({ profile: ref("ClientCrmProfile"), owners: { type: "array", maxItems: 2000, items: object({ id: userId, label: { type: "string" } }) },
    followups: ref("ClientCrmFollowupPage"), history: ref("ClientCrmEventPage"), client_active: { type: "boolean" }, can_write: { type: "boolean" } }),
  ClientCrmCommand: { oneOf: [
    command("QUALIFY", { expected_version: { ...version, minimum: 0 }, customer_kind: textEnum(CRM_CUSTOMER_KINDS), stage: textEnum(CRM_STAGES),
      owner_user_id: nullable(userId), contact_policy: textEnum(CRM_CONTACT_POLICIES), retention_review_date: nullable({ type: "string", format: "date" }) }),
    command("PLAN", { expected_profile_version: { ...version, minimum: 0 }, contact_id: nullable(uuid), owner_user_id: userId, channel: textEnum(CRM_CHANNELS),
      purpose: textEnum(CRM_PURPOSES), title: nullable({ type: "string", minLength: 3, maxLength: 160 }), due_at: timestamp }),
    command("RESCHEDULE", { ...existing, due_at: timestamp, owner_user_id: userId, reason: textEnum(CRM_RESCHEDULE_REASONS), note }),
    command("COMPLETE", { ...existing, outcome: textEnum(CRM_OUTCOMES), note }),
    command("CANCEL", { ...existing, reason: { type: "string", minLength: 3, maxLength: 500 } }),
    command("LOG_INTERACTION", { contact_id: nullable(uuid), channel: textEnum(CRM_CHANNELS), outcome: textEnum(CRM_OUTCOMES), occurred_at: timestamp, note }),
  ], discriminator: { propertyName: "action" }, description: "OTHER nécessite un objet/motif/résultat précisé. Le serveur impose version attendue, client/contact actifs et canal autorisé. Aucun envoi externe." },
  ClientCrmCommandResult: object({ event_id: uuid, profile: ref("ClientCrmProfile"), followup: ref("ClientCrmFollowup") }, ["event_id"]),
};
export function clientCrmOperation(key: string, operation: Schema): Schema {
  if (!["get /clients/{id}/crm", "get /clients/crm/followups", "post /clients/{id}/crm/commands"].includes(key)) return operation;
  const inherited = operation.responses as Schema;
  const response = (name: string, description: string) => ({ description, content: { "application/json": { schema: ref(name) } } });
  const path = key.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: clientId }] : [];
  const query = (name: string, schema: Schema) => ({ name, in: "query", required: false, schema });
  if (key === "get /clients/{id}/crm") return { ...operation, summary: "Suivi et historique de la fiche client/prospect canonique",
    parameters: [...path, ...["followup_page", "history_page"].map(name => query(name, { type: "integer", minimum: 1, maximum: 100000, default: 1 }))],
    responses: { ...inherited, "200": response("ClientCrmDetail", "Suivi, relances et historique paginés."), "404": { description: "Fiche introuvable." } } };
  if (key === "get /clients/crm/followups") return { ...operation, summary: "Relances prévues des clients actifs : retard, à venir, responsable",
    parameters: [query("scope", { ...textEnum(["OVERDUE", "UPCOMING", "ALL"]), default: "OVERDUE" }), query("owner_user_id", userId), query("client_id", clientId),
      query("days", { type: "integer", minimum: 1, maximum: 365, default: 30 }), query("page", { type: "integer", minimum: 1, maximum: 100000, default: 1 }),
      query("page_size", { type: "integer", minimum: 1, maximum: 100, default: 25 })],
    responses: { ...inherited, "200": response("ClientCrmFollowupPage", "Relances à faire, sans courriel/téléphone personnel." ) } };
  return { ...operation, summary: "Qualifier, planifier, reporter, terminer, annuler ou noter un échange",
    "x-cerp-idempotency": "required", parameters: [...path, { name: "Idempotency-Key", in: "header", required: true, schema: uuid }],
    requestBody: { required: true, content: { "application/json": { schema: ref("ClientCrmCommand") } } },
    responses: { ...inherited, "200": response("ClientCrmCommandResult", "Résultat original retrouvé avec la même clé et le même corps."),
      "201": response("ClientCrmCommandResult", "Action, état, audit et événement temps réel enregistrés ensemble."),
      "404": { description: "Client ou relance introuvable." }, "503": { description: "Résultat incertain : réessayer strictement la même commande et clé." } } };
}
