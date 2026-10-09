const uuid = { type: "string", format: "uuid" };
const lane = { type: "string", enum: ["FREE", "DELIVERY", "ASSEMBLY"] };
const decimal = { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?$" };
const bool = { type: "boolean" };
const integer = { type: "integer", minimum: 0 };
const text = { type: "string" };
const nullableText = { ...text, nullable: true };
const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });

export function stockLanesOperation(key: string, operation: Record<string, unknown>) {
  const configure = key === "put /stock/lanes/locations/{locationId}";
  const locations = key === "get /stock/lanes/locations";
  const positions = key === "get /stock/lanes/positions";
  if (!configure && !locations && !positions) return operation;
  const location = { type: "object", required: ["location_id", "emplacement_id", "emplacement_code",
    "magasin_id", "magasin_code", "lane", "version", "facts", "choices"], properties: {
    location_id: uuid, emplacement_id: integer, emplacement_code: text, magasin_id: uuid, magasin_code: text,
    lane: { ...lane, nullable: true }, version: integer,
    facts: { type: "object", required: ["active", "mapped", "storage", "inbound", "outbound", "previousLane",
      "hasStock", "hasReservations", "hasDeliveryOrAssemblyReservations"], properties: {
      active: bool, mapped: bool, storage: bool, inbound: bool, outbound: bool, previousLane: { ...lane, nullable: true },
      hasStock: bool, hasReservations: bool, hasDeliveryOrAssemblyReservations: bool,
    } }, choices: { type: "array", items: { type: "object", required: ["value", "label", "blockers"],
      properties: { value: lane, label: text, blockers: { type: "array", items: text } } } },
  } };
  const position = { type: "object", required: ["position_id", "stock_level_id", "stock_batch_id", "location_id",
    "lane", "magasin_code", "emplacement_code", "article_id", "article_code", "designation", "unit", "lot_id",
    "lot_code", "lot_status", "source_scope", "physical_qty", "reserved_qty", "delivery_reserved_qty",
    "assembly_reserved_qty", "other_reserved_qty", "unreserved_qty", "available_by_lot_status_qty", "unexplained_reserved_qty"],
    properties: { position_id: uuid, stock_level_id: uuid, stock_batch_id: { ...uuid, nullable: true }, location_id: uuid,
      lane: { ...lane, nullable: true }, magasin_code: nullableText, emplacement_code: nullableText,
      article_id: uuid, article_code: text, designation: text, unit: text, lot_id: { ...uuid, nullable: true },
      lot_code: nullableText, lot_status: nullableText, source_scope: text,
      ...Object.fromEntries(["physical_qty", "reserved_qty", "delivery_reserved_qty", "assembly_reserved_qty",
        "other_reserved_qty", "unreserved_qty", "available_by_lot_status_qty", "unexplained_reserved_qty"].map(name => [name, decimal])),
    } };
  const response = configure ? { type: "object", required: ["result", "replayed"], properties: { replayed: bool,
    result: { type: "object", required: ["location_id", "lane", "version"], properties: { location_id: uuid, lane, version: integer } } } }
    : locations ? { type: "object", required: ["locations", "lanes", "as_of", "routing_active", "can_configure"],
      properties: { locations: { type: "array", items: location }, lanes: { type: "array", items: { type: "object",
        required: ["value", "label", "configured_locations", "usable_locations"], properties: { value: lane, label: text,
          configured_locations: integer, usable_locations: integer } } }, as_of: text, routing_active: { ...bool, enum: [false] }, can_configure: bool } }
    : { type: "object", required: ["items", "total", "page", "page_size", "as_of", "routing_active", "availability_scope"], properties: {
      items: { type: "array", maxItems: 100, items: position }, total: integer, page: { type: "integer", minimum: 1 },
      page_size: { type: "integer", minimum: 1, maximum: 100 }, as_of: text, routing_active: { ...bool, enum: [false] },
      availability_scope: { type: "string", enum: ["PHYSICAL_LOT_STATUS_ONLY"] },
    } };
  return { ...operation, summary: configure ? "Affecter un emplacement à une piste" : locations ? "Paramétrage des pistes physiques" : "Positions de stock par piste",
    description: "Socle de configuration uniquement : aucun mouvement ou reclassement implicite du stock. Les disponibilités exposées ne remplacent pas le contrôle qualité opérationnel. Le routage automatique sera activé séparément après configuration et reprise explicite.",
    parameters: configure ? [{ name: "locationId", in: "path", required: true, schema: uuid }] : positions ? [
      { name: "lane", in: "query", schema: { type: "string", enum: ["FREE", "DELIVERY", "ASSEMBLY", "UNASSIGNED"] } },
      ...["article_id", "location_id"].map(name => ({ name, in: "query", schema: uuid })),
      { name: "q", in: "query", schema: { type: "string", maxLength: 160 } },
      { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 100000, default: 1 } },
      { name: "page_size", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 30 } },
    ] : [],
    ...(configure ? { requestBody: { required: true, content: json({ type: "object", additionalProperties: false,
      required: ["lane", "expected_version", "request_id", "reason"], properties: { lane,
        expected_version: { type: "integer", minimum: 0, maximum: 2147483647 }, request_id: uuid,
        reason: { type: "string", minLength: 3, maxLength: 500 } } }) } } : {}),
    responses: { ...((operation.responses as Record<string, unknown>) ?? {}),
      "200": { description: configure ? "Confirmation déjà enregistrée." : "Lecture cohérente des pistes.", content: json(response) },
      ...(configure ? { "201": { description: "Configuration et preuve enregistrées atomiquement.", content: json(response) },
        "404": { description: "Emplacement introuvable." } } : {}),
      "409": { description: "Migration requise, emplacement incompatible ou occupé, version modifiée ou clé de confirmation réutilisée." },
    }, "x-cerp-idempotency": configure ? "required" : "not-declared",
    "x-cerp-rbac": [...((operation["x-cerp-rbac"] as string[]) ?? []), configure ? "stock:referential_manage" : "stock:read"],
  };
}
