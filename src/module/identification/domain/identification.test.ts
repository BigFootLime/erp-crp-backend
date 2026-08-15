import { describe, expect, it } from "vitest";

import {
  buildIdentificationPayload,
  FLOW_ENTITY_TYPES,
  forbiddenStatusReason,
  parseIdentificationPayload,
  roleCanManageEntity,
  roleCanReadEntity,
  scanReplayIdentityMatches,
  targetRoute,
  validateClientScanTimestamp,
} from "./identification";

describe("SOL-30 identification contract", () => {
  const publicId = "11111111-1111-4111-8111-111111111111";

  it("round-trips the non-secret versioned payload", () => {
    const payload = buildIdentificationPayload(publicId);
    expect(payload).toBe(`CERP:1:${publicId}`);
    expect(parseIdentificationPayload(` ${payload.toUpperCase()} `)).toBe(publicId);
    expect(payload).not.toContain("OF-");
  });

  it("rejects ambiguous and legacy payloads", () => {
    for (const value of ["111", `CERP:2:${publicId}`, `https://erp.invalid/of/${publicId}`, `CERP:1:${publicId}:extra`]) {
      expect(() => parseIdentificationPayload(value)).toThrowError(/Code non reconnu/);
    }
  });

  it("keeps each operational flow constrained to explicit entity types", () => {
    expect(FLOW_ENTITY_TYPES.START_WORK_ORDER).toEqual(["WORK_ORDER"]);
    expect(FLOW_ENTITY_TYPES.SHIP).toEqual(["DELIVERY", "STOCK_LOT"]);
    expect(FLOW_ENTITY_TYPES.TOOL_RETURN).toEqual(["TOOL", "WORK_ORDER"]);
    expect(FLOW_ENTITY_TYPES.RECEIVE).not.toContain("DELIVERY");
  });

  it("blocks dangerous lifecycle states without turning missing status into ready", () => {
    expect(forbiddenStatusReason("STOCK_LOT", "QUARANTAINE", "CONSUME")).toMatch(/Lot/);
    expect(forbiddenStatusReason("DELIVERY", null, "SHIP")).toMatch(/sans statut/);
    expect(forbiddenStatusReason("DELIVERY", "READY", "SHIP")).toBeNull();
    expect(forbiddenStatusReason("WORK_ORDER", "TERMINE", "START_WORK_ORDER")).toMatch(/OF/);
  });

  it("rejects stale and future offline timestamps deterministically", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(validateClientScanTimestamp(new Date("2026-08-14T11:55:00.000Z"), now)).toBe("OK");
    expect(validateClientScanTimestamp(new Date("2026-08-07T11:59:59.000Z"), now)).toBe("STALE_OFFLINE_EVENT");
    expect(validateClientScanTimestamp(new Date("2026-08-14T12:05:01.000Z"), now)).toBe("FUTURE_TIMESTAMP");
  });

  it("enforces entity-specific RBAC and stable target routes", () => {
    expect(roleCanReadEntity("Magasinier", "STOCK_LOT")).toBe(true);
    expect(roleCanReadEntity("Magasinier", "QUALITY_CONTROL")).toBe(false);
    expect(roleCanManageEntity("Opérateur atelier", "WORK_ORDER")).toBe(false);
    expect(roleCanManageEntity("Responsable Production", "WORK_ORDER")).toBe(true);
    expect(targetRoute("QUALITY_CONTROL", publicId)).toBe(`/qualite/controles/${publicId}`);
  });

  it("accepts only an exact idempotent scan replay", () => {
    const stored = {
      actor_user_id: 31,
      payload_sha256: "a".repeat(64),
      flow: "CONSUME",
      source: "OFFLINE",
      client_scanned_at: "2026-08-14T10:00:00.000Z",
      expected_entity_types: ["STOCK_LOT", "WORK_ORDER"],
      device_id: "POSTE-01",
    };
    expect(scanReplayIdentityMatches(stored, { ...stored })).toBe(true);
    expect(scanReplayIdentityMatches(stored, { ...stored, client_scanned_at: "2026-08-14 10:00:00+00" })).toBe(true);
    expect(scanReplayIdentityMatches(stored, { ...stored, payload_sha256: "b".repeat(64) })).toBe(false);
    expect(scanReplayIdentityMatches(stored, { ...stored, actor_user_id: 32 })).toBe(false);
    expect(scanReplayIdentityMatches(stored, { ...stored, expected_entity_types: ["WORK_ORDER"] })).toBe(false);
  });
});
