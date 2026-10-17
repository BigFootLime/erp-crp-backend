import { describe, expect, it } from "vitest";
import { clientAuditEvent } from "../module/audit-logs/domain/client-audit";
import { createAuditLogBodySchema } from "../module/audit-logs/validators/audit-logs.validators";
describe("browser events are telemetry, not confirmed business proof", () => {
  it("cannot impersonate validation and removes secrets and search contents", () => {
    const event = clientAuditEvent({ event_type: "ACTION", action: "FACTURE_ISSUED", entity_type: "facture", entity_id: "123", path: "/clients?q=fixture@example.invalid", details: { password: "fixture", email: "fixture@example.invalid", token: "fixture", ok: true } });
    expect(event.action).toBe("CLIENT_ACTION");
    expect(event.entity_type).toBe("client_event");
    expect(event.entity_id).toBeNull();
    expect(event.path).toBe("/clients");
    expect(event.details).toMatchObject({ source: "client", metadata: { password: "[redacted]", email: "[redacted]", token: "[redacted]", ok: true } });
  });
  it("retains navigation semantics and rejects an oversized client detail payload", () => {
    expect(clientAuditEvent({event_type:"NAVIGATION",action:"PAGE_VIEW",path:"https://external.invalid/secret"}).path).toBeNull();
    expect(clientAuditEvent({event_type:"NAVIGATION",action:"PAGE_VIEW"}).action).toBe("CLIENT_NAVIGATION");
    expect(createAuditLogBodySchema.safeParse({event_type:"ACTION",action:"X",details:{x:"x".repeat(5000)}}).success).toBe(false);
  });
});
