type Schema = Record<string, any>;
const text = {type: "string"}, uuid = {...text, format: "uuid"}, nullableText = {...text, nullable: true};
const id = {...text, pattern: "^[1-9]\\d{0,15}$"};
const version = {type: "integer", minimum: 1, maximum: 2147483646};
const object = (properties: Schema): Schema => ({type: "object", properties, required: Object.keys(properties), additionalProperties: false});
const ref = (name: string) => ({$ref: `#/components/schemas/${name}`});
const nullable = (name: string) => ({allOf: [ref(name)], nullable: true});
const items = (schema: Schema) => ({type: "array", items: schema});
export const clientContractLegacySchemas: Schema = {
  LegacyContractSourceLine: object({id, article_id: {...uuid, nullable: true}, root_article_id: {...uuid, nullable: true},
    piece_technique_id: {...uuid, nullable: true}, piece_technique_version_id: {...uuid, nullable: true}, indice: nullableText,
    unit_id: {...uuid, nullable: true}, unit: nullableText, code: nullableText, designation: nullableText,
    quantity: text, due_date: nullableText, technical_identity_valid: {type: "boolean"}}),
  LegacyContractSource: object({id, numero: text, client_id: text, customer_reference: nullableText, order_date: nullableText,
    order_type: {...text, enum: ["CADRE"]}, lines: items(ref("LegacyContractSourceLine")),
    releases: items(object({id, number: text, request_date: text, due_date: nullableText,
      status: {...text, enum: ["PLANNED", "SENT", "CONFIRMED", "DELIVERED", "CANCELLED"]},
      lines: items(object({id, source_line_id: {...id, nullable: true}, article_id: {...uuid, nullable: true}, quantity: text,
        unit: nullableText, due_date: nullableText}))}))}),
  LegacyContractAssociation: object({id: uuid, contract_id: uuid, commande_id: id, contract_version: version,
    reference: text, reason: text, actor_user_id: version, created_at: {...text, format: "date-time"}}),
  LegacyContractOrders: object({items: items(object({id, numero: text, customer_reference: nullableText, order_date: nullableText,
    associated_contract_id: {...uuid, nullable: true}, associated_contract_reference: nullableText, line_count: {type: "integer", minimum: 0}})),
    total: {type: "integer", minimum: 0}, page: {type: "integer", minimum: 1, maximum: 100000}, page_size: {type: "integer", enum: [25]}}),
  LegacyContractPreview: object({source: ref("LegacyContractSource"), source_hash: {...text, pattern: "^[a-f0-9]{64}$"}, contract_version: version,
    mappings: items(object({commande_ligne_id: id, contract_line_id: uuid, article_id: uuid, root_article_id: uuid,
      piece_technique_version_id: {...uuid, nullable: true}, unit_id: uuid, historical_line: ref("LegacyContractSourceLine")})),
    issues: items(object({line_id: {...id, nullable: true}, code: text, message: text})), association: nullable("LegacyContractAssociation"),
    recorded_source: nullable("LegacyContractSource"), eligible: {type: "boolean"}}),
  LegacyContractBind: object({commande_id: id, expected_contract_version: version,
    expected_source_hash: {...text, pattern: "^[a-f0-9]{64}$"}, reason: {...text, minLength: 3, maxLength: 500}}),
};

export function clientContractLegacyOperation(key: string, operation: Schema): Schema {
  if (["patch /commandes/{id}", "delete /commandes/{id}", "post /commandes/{id}/duplicate"].includes(key)) {
    return {...operation, description: [operation.description,
      "Explicitly associated historical CADRE orders retain their client, order type, line IDs, article, technical identity and unit. Existing quantity/date edits retain the recorded source snapshot. New historical lines, deletion and duplication are refused; future requests use the firm client-contract call flow."].filter(Boolean).join("\n\n")};
  }
  const list = "get /clients/{id}/contracts/{contractId}/legacy-orders";
  const preview = "get /clients/{id}/contracts/{contractId}/legacy-orders/{commandeId}/preview";
  const bind = "post /clients/{id}/contracts/{contractId}/legacy-orders/associations";
  if (![list, preview, bind].includes(key)) return operation;
  const parameters: Schema[] = [{name: "id", in: "path", required: true, schema: {type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$"}},
    {name: "contractId", in: "path", required: true, schema: uuid}];
  if (key === preview) parameters.push({name: "commandeId", in: "path", required: true, schema: id});
  if (key === list) parameters.push({name: "page", in: "query", required: false, schema: {type: "integer", minimum: 1, maximum: 100000, default: 1}});
  const response = (name: string, description: string) => ({description, content: {"application/json": {schema: ref(name)}}});
  const errors = {...operation.responses, "404": {description: "Client, contract or historical CADRE not found in this client scope."},
    "409": {description: "Inactive/stale contract or client, changed source, existing association/firm call, conflicting retry key or incompatible pending BL. Entire command rolls back."},
    "422": {description: "Historical family/unit/technical identity does not match the contract."},
    "503": {description: "Uncertain outcome: retain the exact body and Idempotency-Key and retry it."}};
  const base = {...operation, parameters, responses: errors,
    description: "Explicit commercial association only. Historical orders, lines, BL, OF, AR, stock and quality decisions are not rewritten. Actual article families and unique canonical units must match; no name or current-index inference. A missing historical technical version stays unknown. Associated source snapshots are immutable."};
  if (key === bind) return {...base, summary: "Rattacher explicitement un ancien cadre au contrat client",
    parameters: [...parameters, {name: "Idempotency-Key", in: "header", required: true, schema: uuid}], "x-cerp-idempotency": "required",
    requestBody: {required: true, content: {"application/json": {schema: ref("LegacyContractBind")}}},
    responses: {...errors, "200": response("LegacyContractAssociation", "Initial result replayed."),
      "201": response("LegacyContractAssociation", "Association, source snapshot, audit and outbox recorded atomically.")}};
  return {...base, summary: key === list ? "Lister les cadres historiques du même client" : "Prévisualiser les identités historiques et leur correspondance",
    responses: {...errors, "200": response(key === list ? "LegacyContractOrders" : "LegacyContractPreview", "Private, no-store read model.")}};
}
