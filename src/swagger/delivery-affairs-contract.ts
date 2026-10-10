type Schema = Record<string, unknown>;
const text = { type: "string" }, nullable = { ...text, nullable: true }, id = { type: "integer", minimum: 1 }, qty = { type: "number", minimum: 0 };
const properties: Record<string, Schema> = { allocation_id: id, commande_id: id, commande_ligne_id: id, livraison_affaire_id: id,
    commande_numero: text, customer_order_reference: nullable, client_id: text, client_code: nullable, client_name: text,
    delivery_address_id: nullable, affaire_reference: text, article_id: nullable, article_code: nullable, article_indice: nullable,
    designation: nullable, unit: nullable, ar_due_date: nullable, requested_due_date: nullable, requested_qty: qty, reserved_qty: qty,
    available_qty: qty, prepared_qty: qty, shipped_qty: qty, remaining_qty: qty,
    delivery_state: { type: "string", enum: ["PENDING", "PARTIAL", "COMPLETE"] }, delivery_readiness_state: nullable,
    contract_group_key: text, contract_reference: nullable, can_prepare: { type: "boolean" },
    preparable_reservation_ids: { type: "array", items: { type: "string", format: "uuid" } } };
const object = (fields: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields });
const recoveryResult = { allocation_id:id,livraison_affaire_id:id,commande_id:id,reserved_qty:qty,shortage_qty:qty,
    reservation_ids:{type:'array',minItems:1,items:{type:'string',format:'uuid'}},idempotent_replay:{type:'boolean'} };
export const deliveryAffairsSchemas: Record<string, Schema> = {
    DeliveryStockRecoveryResult: object(recoveryResult),
    DeliveryStockRecoveryRequest: object({preview_hash:{...text,pattern:'^[0-9a-f]{64}$'},reason:{...text,minLength:3,maxLength:500}}),
    DeliveryStockRecoveryPreview: object({allocation_id:id,commande_id:id,livraison_affaire_id:id,commande_numero:text,customer_order_reference:nullable,
        affaire_reference:text,client_name:text,client_code:nullable,article_code:text,indice:text,designation:nullable,unit:nullable,ar_due_date:nullable,
        ordered_qty:qty,shipped_qty:qty,reserved_qty:qty,prepared_without_reservation_qty:qty,uncovered_qty:qty,reservable_qty:qty,shortage_qty:qty,
        preview_hash:{...text,pattern:'^[0-9a-f]{64}$'},lane_status:{...text,enum:['ACTIVE','CONFIGURING']},candidate_limit_reached:{type:'boolean'},
        lots:{type:'array',maxItems:200,items:object({lot_id:{...text,format:'uuid'},lot_code:text,stock_batch_id:{...text,format:'uuid'},
            scope:{...text,enum:['OLD','NEW','UNKNOWN']},location:text,available_qty:qty,proposed_qty:qty,blocker:nullable})}}),
    DeliveryAffairLine: { type: "object", additionalProperties: false, required: Object.keys(properties), properties },
    DeliveryAffairs: { type: "object", additionalProperties: false, required: ["items", "total", "page", "pageSize", "as_of", "quantity_basis", "ar_basis"],
        properties: { items: { type: "array", items: { $ref: "#/components/schemas/DeliveryAffairLine" } }, total: { type: "integer", minimum: 0 },
            page: id, pageSize: id, as_of: text, quantity_basis: { ...text, enum: ["SHIPPED_OR_DELIVERED_BL_ALLOCATIONS"] },
            ar_basis: { ...text, enum: ["IMMUTABLE_SENT_AR"] } } },
};
export function deliveryAffairsOperation(key: string, operation: Schema): Schema {
    const recoveryPreview=key==='get /livraisons/affaires/allocations/{allocationId}/reservation-preview';
    const recoveryWrite=key==='post /livraisons/affaires/allocations/{allocationId}/reserve-stock';
    if(recoveryPreview||recoveryWrite)return {...operation,
        summary:recoveryPreview?'Contrôler le stock libre du restant d’une affaire':'Réserver le restant d’une affaire sur stock libre',
        description:'Same canonical delivery allocation, client, technical compatibility, quality and OLD evidence. DELIVERY/ASSEMBLY lanes excluded. No OF, AR, email or physical OUT. Confirmation recomputes the preview under locks; stale coverage refuses409. Historical cancellations and initial AR remain immutable.',
        parameters:[{name:'allocationId',in:'path',required:true,schema:id},...(recoveryWrite?[{name:'Idempotency-Key',in:'header',required:true,schema:{...text,minLength:8,maxLength:200}}]:[])],
        ...(recoveryWrite?{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/DeliveryStockRecoveryRequest'}}}}}:{}),
        responses:{...(operation.responses as Schema),'200':{description:'Canonical reservation result or read-only stock proposal.',content:{'application/json':{schema:{$ref:`#/components/schemas/${recoveryPreview?'DeliveryStockRecoveryPreview':'DeliveryStockRecoveryResult'}`}}}}}};
    if (key === "get /livraisons/preparation-cart")
        return { ...operation, parameters: [...(operation.parameters as Schema[] ?? []),
                { name: "reservation_ids", in: "query", required: false, schema: { type: "string" }, description: "Optional comma-separated UUIDs, 1–200. Limits the cart to reservations from the selected affair lines." }] };
    if (key !== "get /livraisons/affaires")
        return operation;
    return { ...operation, summary: "Affaires à livrer, y compris sans réservation", description: "One row per canonical article/affair allocation. Read-only, one database snapshot. Requested/reserved/prepared quantities are distinct; shipped quantities derive from SHIPPED/DELIVERED BL allocations, excluding cancelled BLs. Initial AR is immutable sent-AR evidence or null, never a replacement by today's commercial date. Preparation retains the existing physical/quality/contract gates.",
        parameters: [{ name: "q", in: "query", schema: { ...text, maxLength: 160 } },
            { name: "client_id", in: "query", schema: text }, { name: "commande_id", in: "query", schema: id },
            { name: "affaire_id", in: "query", schema: id }, { name: "state", in: "query", schema: { ...text, enum: ["ALL", "PENDING", "PARTIAL", "COMPLETE"], default: "ALL" } },
            { name: "page", in: "query", schema: { ...id, maximum: 100000, default: 1 } },
            { name: "pageSize", in: "query", schema: { ...id, maximum: 100, default: 24 } }],
        responses: { ...(operation.responses as Schema), "200": { description: "Allocation backlog and counters on one snapshot.",
                content: { "application/json": { schema: { $ref: "#/components/schemas/DeliveryAffairs" } } } } } };
}
