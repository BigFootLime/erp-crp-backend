import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueEntityChanged: vi.fn().mockResolvedValue("event-id"),
}));

vi.mock("../shared/realtime/realtime-outbox.service", () => ({
  enqueueEntityChanged: mocks.enqueueEntityChanged,
}));

import { enqueueMetrologieEquipmentChanged } from "../module/metrologie/repository/metrologie.repository";
import { enqueueMetrologyEquipmentChanged } from "../module/metrologie/repository/metrology-shared.repository";
import { enqueueProductionOfChanged } from "../module/production/repository/production-realtime.repository";
import { enqueueQualityEntityChanged } from "../module/qualite/repository/qualite.repository";
import { enqueueQuality360EntityChanged } from "../module/qualite/repository/quality-360.repository";
import { enqueueReceptionChanged } from "../module/receptions/repository/receptions-realtime.repository";

const tx = { query: vi.fn() } as never;
const occurredAt = "2026-08-04T12:00:00.000Z";

describe("module-owned durable realtime producers", () => {
  beforeEach(() => mocks.enqueueEntityChanged.mockClear());

  it("maps legacy metrology plan events to the equipment room with the durable event id", async () => {
    await enqueueMetrologieEquipmentChanged(tx, {
      equipementId: "equipment-1",
      eventId: "met-event-1",
      eventType: "PLAN_UPSERT",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "METROLOGIE_EQUIPEMENT",
      entityId: "equipment-1",
      module: "metrologie",
      action: "status_changed",
      at: occurredAt,
    }), { deduplicationKey: "metrologie-event:met-event-1" });
  });

  it("maps Metrology 360 transitions and includes center invalidation", async () => {
    await enqueueMetrologyEquipmentChanged(tx, {
      equipementId: "equipment-2",
      eventId: "met360-event-1",
      eventType: "EQUIPEMENT_TRANSITION",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "METROLOGIE_EQUIPEMENT",
      entityId: "equipment-2",
      action: "status_changed",
      invalidateKeys: expect.arrayContaining(["metrologie:center", "metrologie:equipement:equipment-2"]),
    }), { deduplicationKey: "metrology-event:met360-event-1" });
  });

  it("does not classify child certificate/plan mutations as equipment deletion/creation", async () => {
    await enqueueMetrologieEquipmentChanged(tx, {
      equipementId: "equipment-3",
      eventId: "met-event-certificate",
      eventType: "CERTIFICAT_REMOVE",
      occurredAt,
    });
    await enqueueMetrologyEquipmentChanged(tx, {
      equipementId: "equipment-4",
      eventId: "met360-event-plan",
      eventType: "PLAN_VERSION_CREATED",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenNthCalledWith(1, tx, expect.objectContaining({
      entityId: "equipment-3",
      action: "updated",
    }), { deduplicationKey: "metrologie-event:met-event-certificate" });
    expect(mocks.enqueueEntityChanged).toHaveBeenNthCalledWith(2, tx, expect.objectContaining({
      entityId: "equipment-4",
      action: "updated",
    }), { deduplicationKey: "metrology-event:met360-event-plan" });
  });

  it("maps quality NCR document mutations to the NCR room", async () => {
    await enqueueQualityEntityChanged(tx, {
      entityType: "NON_CONFORMITY",
      entityId: "nc-1",
      eventId: "quality-event-1",
      eventType: "DOCUMENT_ATTACH",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "NCR",
      entityId: "nc-1",
      module: "qualite",
      action: "updated",
      invalidateKeys: expect.arrayContaining(["qualite:non-conformity:nc-1:dispositions"]),
    }), { deduplicationKey: "quality-event:quality-event-1" });
  });

  it("maps Quality 360 NC transitions with their append-only event id", async () => {
    await enqueueQuality360EntityChanged(tx, {
      entityType: "NON_CONFORMITY",
      entityId: "nc-2",
      eventId: "quality360-event-1",
      eventType: "NC_TRANSITION",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "NCR",
      entityId: "nc-2",
      action: "status_changed",
    }), { deduplicationKey: "quality-360-event:quality360-event-1" });
  });

  it("maps production receipts to OF status changes with the audit id", async () => {
    await enqueueProductionOfChanged(tx, {
      ofId: 170,
      auditId: "audit-production-1",
      action: "status_changed",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "OF",
      entityId: "170",
      module: "production",
      action: "status_changed",
      invalidateKeys: expect.arrayContaining(["production:of:170:receipt-context", "production:of:170:traceability"]),
    }), { deduplicationKey: "production-audit:audit-production-1:of:170" });
  });

  it("maps incoming-inspection decisions to their reception room", async () => {
    await enqueueReceptionChanged(tx, {
      receptionId: "reception-1",
      auditId: "audit-reception-1",
      action: "status_changed",
      occurredAt,
    });

    expect(mocks.enqueueEntityChanged).toHaveBeenCalledWith(tx, expect.objectContaining({
      entityType: "RECEPTION",
      entityId: "reception-1",
      module: "receptions",
      action: "status_changed",
      invalidateKeys: ["receptions:list", "receptions:kpis", "receptions:detail:reception-1"],
    }), { deduplicationKey: "reception-audit:audit-reception-1" });
  });
});
