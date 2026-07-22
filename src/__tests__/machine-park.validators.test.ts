import { describe, expect, it } from "vitest";

import { roleHasMachineCapability, type MachineCapability } from "../module/production/domain/machine-rbac";
import {
  createMachineMaintenancePlanSchema,
  createMachineUnavailabilitySchema,
  uploadMachineDocumentSchema,
} from "../module/production/validators/machine-park.validators";
import {
  createMachineSchema,
  updateMachineSchema,
} from "../module/production/validators/production.validators";

const causes = [
  "PREVENTIVE_MAINTENANCE",
  "BREAKDOWN",
  "QUALIFICATION",
  "RESERVATION",
  "WORKSHOP_CLOSURE",
  "OPERATOR_ABSENCE",
  "OTHER",
] as const;

const validPeriods = causes.flatMap((cause, causeIndex) =>
  Array.from({ length: 12 }, (_, index) => {
    const startHour = (causeIndex + index) % 20;
    const endHour = startHour + 1 + (index % 3);
    return {
      label: `${cause}-${index + 1}`,
      body: {
        cause,
        comment: cause === "OTHER" ? `Justification ${index + 1}` : null,
        start_ts: `2026-08-${String(1 + causeIndex).padStart(2, "0")}T${String(startHour).padStart(2, "0")}:00:00.000Z`,
        end_ts: `2026-08-${String(1 + causeIndex).padStart(2, "0")}T${String(endHour).padStart(2, "0")}:00:00.000Z`,
      },
    };
  })
);

const invalidPeriods = Array.from({ length: 24 }, (_, index) => {
  const hour = index % 20;
  return {
    label: `invalid-order-${index + 1}`,
    body: {
      cause: "BREAKDOWN",
      comment: "Panne",
      start_ts: `2026-09-01T${String(hour).padStart(2, "0")}:30:00.000Z`,
      end_ts: `2026-09-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
    },
  };
});

describe("machine park strict validation matrix", () => {
  it.each(validPeriods)("accepts canonical period $label", ({ body }) => {
    expect(createMachineUnavailabilitySchema.safeParse({ body }).success).toBe(true);
  });

  it.each(invalidPeriods)("rejects malformed period $label", ({ body }) => {
    expect(createMachineUnavailabilitySchema.safeParse({ body }).success).toBe(false);
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "rejects OTHER without a justification, combination %s",
    (index) => {
      const start = String(index).padStart(2, "0");
      const end = String(index + 1).padStart(2, "0");
      expect(createMachineUnavailabilitySchema.safeParse({
        body: { cause: "OTHER", start_ts: `2026-09-02T${start}:00:00.000Z`, end_ts: `2026-09-02T${end}:00:00.000Z` },
      }).success).toBe(false);
    }
  );

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "accepts maintenance by due date or frequency, combination %s",
    (index) => {
      const body = index % 2 === 0
        ? { title: `Controle ${index}`, frequency_days: index * 5 }
        : { title: `Controle ${index}`, next_due_at: `2027-01-${String(index).padStart(2, "0")}` };
      expect(createMachineMaintenancePlanSchema.safeParse({ body }).success).toBe(true);
    }
  );

  it("keeps a missing hourly rate null and refuses client-owned machine codes", () => {
    const base = { name: "Centre 1", type: "MILLING", status: "ACTIVE", hourly_rate: null };
    const parsed = createMachineSchema.parse({ body: base }).body;
    expect(parsed.hourly_rate).toBeNull();
    expect(createMachineSchema.safeParse({ body: { ...base, code: "CLIENT-001" } }).success).toBe(false);
    expect(createMachineSchema.safeParse({ body: { ...base, is_available: true } }).success).toBe(false);
  });

  it("requires optimistic concurrency and rejects code mutation", () => {
    expect(updateMachineSchema.safeParse({ body: { name: "Nouveau nom" } }).success).toBe(false);
    expect(updateMachineSchema.safeParse({ body: { code: "MCH-999999", expected_updated_at: "2026-07-22T10:00:00.000Z" } }).success).toBe(false);
    expect(updateMachineSchema.safeParse({ body: { name: "Nouveau nom", expected_updated_at: "2026-07-22T10:00:00.000Z" } }).success).toBe(true);
  });

  it("validates private document metadata without accepting an internal path", () => {
    const body = {
      title: "Manuel constructeur",
      document_type: "MANUAL",
      revision: "B",
      source_type: "manufacturer_pdf",
      source_confidence: "official",
      source_notes: "Document constructeur verifie",
    };
    expect(uploadMachineDocumentSchema.safeParse({ body }).success).toBe(true);
    expect(uploadMachineDocumentSchema.safeParse({ body: { ...body, storage_path: "C:/secret/manual.pdf" } }).success).toBe(false);
  });
});

describe("machine park RBAC deny-by-default matrix", () => {
  const capabilities: MachineCapability[] = ["read", "create", "update", "archive", "restore", "model_update", "availability", "maintenance", "documents", "costs"];

  it.each(capabilities)("denies anonymous role for %s", (capability) => {
    expect(roleHasMachineCapability("", capability)).toBe(false);
    expect(roleHasMachineCapability(undefined, capability)).toBe(false);
  });

  it.each(capabilities)("grants administrator role for %s", (capability) => {
    expect(roleHasMachineCapability("Administrateur", capability)).toBe(true);
  });

  it("separates operational and sensitive capabilities", () => {
    expect(roleHasMachineCapability("Atelier", "availability")).toBe(true);
    expect(roleHasMachineCapability("Atelier", "archive")).toBe(false);
    expect(roleHasMachineCapability("Maintenance", "maintenance")).toBe(true);
    expect(roleHasMachineCapability("Maintenance", "costs")).toBe(false);
    expect(roleHasMachineCapability("Comptabilite", "costs")).toBe(true);
    expect(roleHasMachineCapability("Comptabilite", "update")).toBe(false);
  });
});
