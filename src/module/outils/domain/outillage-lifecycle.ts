import { effectiveRoleHasAny } from "../../auth/domain/roles";

export type OutillageCapability = "read" | "operate" | "configure";

const OPERATE_ROLES = [
  "Administrateur Systeme et Reseau",
  "Directeur",
  "Production",
  "Atelier",
  "Responsable Production",
  "Responsable Programmation",
  "Method",
  "Stock",
  "Magasin",
  "Magasinier",
  "Operateur Atelier",
  "Opérateur atelier",
  "Operateur CN",
  "Opérateur CN",
] as const;

const CONFIGURE_ROLES = [
  "Administrateur Systeme et Reseau",
  "Directeur",
  "Production",
  "Responsable Production",
  "Responsable Programmation",
  "Method",
] as const;

export function roleHasOutillageCapability(
  role: string | null | undefined,
  capability: OutillageCapability
): boolean {
  if (capability === "read") return Boolean(role?.trim());
  return effectiveRoleHasAny(role, capability === "operate" ? OPERATE_ROLES : CONFIGURE_ROLES);
}

export function hasOutillageCapability(
  moduleAccessGranted: boolean,
  role: string | null | undefined,
  capability: OutillageCapability
): boolean {
  return moduleAccessGranted && roleHasOutillageCapability(role, capability);
}

export type AllocationState = {
  reserved_quantity: number;
  issued_quantity: number;
  returned_quantity: number;
  broken_quantity: number;
  worn_quantity: number;
  status: string;
};

export type LifecycleEventType = "ISSUE" | "RETURN" | "BREAK" | "WEAR" | "CANCEL";

export function nextAllocationState(
  current: AllocationState,
  eventType: LifecycleEventType,
  quantity: number
): AllocationState {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("INVALID_QUANTITY");
  if (current.status === "CLOSED" || current.status === "CANCELLED") throw new Error("ALLOCATION_CLOSED");

  const next = { ...current };
  const disposed = current.returned_quantity + current.broken_quantity + current.worn_quantity;
  if (eventType === "CANCEL") {
    if (disposed !== current.issued_quantity) throw new Error("ISSUED_ALLOCATION_CANNOT_BE_CANCELLED");
    const unissued = current.reserved_quantity - current.issued_quantity;
    if (quantity !== unissued || unissued <= 0) throw new Error("CANCEL_QUANTITY_MUST_MATCH_RESERVATION");
    // Une réservation jamais sortie reste CANCELLED avec sa quantité historique.
    // Après utilisation partielle, le reliquat est libéré et la quantité
    // effectivement engagée reste visible dans l'allocation CLOSED.
    if (current.issued_quantity === 0) {
      next.status = "CANCELLED";
    } else {
      next.reserved_quantity = current.issued_quantity;
      next.status = "CLOSED";
    }
    return next;
  }
  if (eventType === "ISSUE") {
    if (current.issued_quantity + quantity > current.reserved_quantity) throw new Error("ISSUE_EXCEEDS_RESERVATION");
    next.issued_quantity += quantity;
    next.status = "ISSUED";
    return next;
  }
  if (disposed + quantity > current.issued_quantity) throw new Error("DISPOSITION_EXCEEDS_ISSUED");
  if (eventType === "RETURN") next.returned_quantity += quantity;
  if (eventType === "BREAK") next.broken_quantity += quantity;
  if (eventType === "WEAR") next.worn_quantity += quantity;
  const nextDisposed = next.returned_quantity + next.broken_quantity + next.worn_quantity;
  next.status = nextDisposed === next.reserved_quantity ? "CLOSED" : "PARTIALLY_RETURNED";
  return next;
}
