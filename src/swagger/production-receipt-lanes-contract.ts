type Operation = Record<string, unknown>;
const uuid = { type: "string", format: "uuid" };
const quantity = { type: "number", minimum: 0 };
const decimal = { type: "string", pattern: "^\\d+(?:\\.\\d{1,12})?$" };
const distribution = { type: "object", nullable: true,
  required: ["received_quantity", "physical_routing_applied", "destinations"], properties: {
    received_quantity: decimal, physical_routing_applied: { type: "boolean", enum: [false] },
    destinations: { type: "array", maxItems: 3, items: { type: "object", required: ["lane", "quantity", "reservations"], properties: {
      lane: { type: "string", enum: ["FREE", "DELIVERY", "ASSEMBLY"] }, quantity: decimal,
      reservations: { type: "array", items: { type: "object", required: ["reservation_id", "lane", "quantity"], properties: {
        reservation_id: uuid, lane: { type: "string", enum: ["DELIVERY", "ASSEMBLY"] }, quantity: decimal,
      } } },
    } } },
  } };

export function productionReceiptLanesOperation(key: string, operation: Operation): Operation {
  if (key !== "post /production/ofs/{id}/receipt") return operation;
  const schema = { type: "object", required: ["receipt_id", "lot_id", "lot_code", "stock_movement_id", "movement_no",
    "qty_ok", "qty_scrap", "qty_rework", "quality_status", "reservation_id", "reserved_qty", "auto_reserved_qty",
    "available_qty", "message", "non_conformity_id", "idempotent_replay"], properties: {
    receipt_id: uuid, lot_id: uuid, lot_code: { type: "string" }, stock_movement_id: uuid, movement_no: { type: "string" },
    qty_ok: quantity, qty_scrap: quantity, qty_rework: quantity,
    quality_status: { type: "string", enum: ["LIBERE", "QUARANTAINE", "BLOQUE"] },
    reservation_id: { ...uuid, nullable: true }, reserved_qty: quantity, auto_reserved_qty: quantity,
    available_qty: quantity, message: { type: "string" }, non_conformity_id: { ...uuid, nullable: true },
    idempotent_replay: { type: "boolean" }, lane_distribution: distribution,
  } };
  const success = { description: "Réception physique enregistrée ; affectations seulement après libération qualité.",
    content: { "application/json": { schema } } };
  return { ...operation, description: "La quantité disponible exclut la quarantaine et les réservations. L'affectation indique une destination métier ; les transferts physiques restent désactivés jusqu'au paramétrage complet des pistes.",
    responses: { ...((operation.responses as Operation) ?? {}), "200": success, "201": success,
      "409": { description: "Mise à jour requise, couverture historique à vérifier, stock ou affectations modifiés." } },
  };
}
