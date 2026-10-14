import type { ProformaFundingResult } from "../../facturation/domain/proforma-funding";

export type DeliveryPrepaymentSource = {
  allocationId: number;
  requirement: "NOT_REQUIRED" | "PROFORMA" | "UNCONFIRMED";
  proformaId: string | null;
  documentStatus: "DRAFT" | "ISSUED" | "CANCELLED" | null;
  sourceUnchanged: boolean;
  billingParts: readonly ProformaFundingResult[];
};

export type DeliveryPrepaymentBlocker = { code: string; message: string; allocationId?: number };

/** Recomputed from persisted evidence during preparation, confirmation and shipment. */
export function deliveryPrepaymentBoundary(args: {
  sources: readonly DeliveryPrepaymentSource[];
  hasUnboundLines: boolean;
}): { groupKey: string; blockers: DeliveryPrepaymentBlocker[] } {
  const blockers: DeliveryPrepaymentBlocker[] = [];
  const keys = new Set<string>();
  const seen = new Set<number>();
  for (const source of args.sources) {
    if (seen.has(source.allocationId)) {
      blockers.push({ code: "DELIVERY_PREPAYMENT_SOURCE_DUPLICATED", message: "Une affaire apparaît plusieurs fois dans le contrôle de paiement.", allocationId: source.allocationId });
      continue;
    }
    seen.add(source.allocationId);
    const block = (code: string, message: string) => blockers.push({ code, message, allocationId: source.allocationId });
    if (source.requirement === "UNCONFIRMED") {
      block("DELIVERY_PREPAYMENT_UNCONFIRMED", "Confirmez les conditions de paiement de cette affaire.");
      keys.add("UNCONFIRMED");
      continue;
    }
    if (source.requirement === "NOT_REQUIRED") {
      keys.add("NONE");
      if (source.proformaId || source.billingParts.length || source.documentStatus) {
        block("DELIVERY_PREPAYMENT_BINDING_INCONSISTENT", "L'affaire est liée à une proforma : vérifiez ses conditions de paiement.");
      }
      continue;
    }
    if (!source.proformaId) {
      keys.add("UNCONFIRMED");
      block("DELIVERY_PROFORMA_REQUIRED", "Préparez la proforma de cette affaire avant livraison.");
      continue;
    }
    keys.add(`PROFORMA:${source.proformaId.toLowerCase()}`);
    if (source.documentStatus !== "ISSUED") {
      block("DELIVERY_PROFORMA_NOT_ISSUED", "La proforma de cette affaire doit être émise et payée.");
    }
    if (!source.sourceUnchanged) {
      block("DELIVERY_PROFORMA_SOURCE_CHANGED", "L'affaire a changé depuis la proforma : actualisez sa préparation.");
    }
    if (!source.billingParts.length || source.billingParts.some(part => part.status !== "PAID" || part.blockers.length)) {
      block("DELIVERY_PROFORMA_NOT_PAID", "Le règlement de cette affaire n'est pas entièrement couvert pour chaque société facturée.");
    }
  }
  if (keys.size > 1) blockers.push({ code: "MIXED_DELIVERY_PROFORMA", message: "Un BL regroupe les affaires payées d'une même proforma, ou uniquement des affaires hors proforma." });
  const groupKey = keys.size === 1 ? [...keys][0]! : keys.size ? "INVALID" : "NONE";
  if (args.hasUnboundLines) blockers.push({ code: "DELIVERY_PREPAYMENT_LINE_SOURCE_REQUIRED", message: "Reliez chaque ligne à son affaire pour vérifier les conditions de paiement." });
  return { groupKey, blockers };
}
