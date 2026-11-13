export type DeliveryContractOrder = {
  commande_id: string
  client_id: string | null
  contract_id: string | null
  order_type: string | null
}

export type DeliveryContractBlocker = { code: string; message: string }

/** Historical CADRE identities stay separate until an explicit reprise binds them. */
export function deliveryContractGroupKey(order: DeliveryContractOrder): string {
  if (order.contract_id) return `CONTRACT:${order.contract_id.toLowerCase()}`
  if (order.order_type?.toUpperCase() === "CADRE") return `LEGACY_CADRE:${order.commande_id}`
  return "NONE"
}

export function deliveryContractBoundary(args: {
  clientId: string
  orders: readonly DeliveryContractOrder[]
  hasUnboundLines: boolean
}): { groupKey: string; blocker: DeliveryContractBlocker | null } {
  if (args.orders.some(order => order.client_id !== args.clientId
    && !(order.client_id === null && order.order_type === "INTERNE"))) {
    return { groupKey: "INVALID", blocker: {
      code: "MIXED_DELIVERY_CLIENT", message: "Les lignes du BL doivent appartenir au même client.",
    } }
  }
  if (args.orders.some(order => order.order_type === "INTERNE")
    && args.orders.some(order => order.order_type !== "INTERNE")) {
    return { groupKey: "INVALID", blocker: {
      code: "MIXED_DELIVERY_PURPOSE", message: "Une livraison interne ne se mélange pas avec une livraison client.",
    } }
  }
  const keys = new Set(args.orders.map(deliveryContractGroupKey))
  const groupKey = keys.values().next().value ?? "NONE"
  if (keys.size > 1) return { groupKey: "INVALID", blocker: {
    code: "MIXED_DELIVERY_CONTRACT",
    message: "Un BL peut regrouper un seul contrat, ou uniquement des affaires hors contrat.",
  } }
  if (groupKey !== "NONE" && args.hasUnboundLines) return { groupKey, blocker: {
    code: "DELIVERY_CONTRACT_LINE_SOURCE_REQUIRED",
    message: "Chaque ligne de ce BL doit être liée à une ligne de commande du contrat.",
  } }
  return { groupKey, blocker: null }
}
