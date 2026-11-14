import { beforeEach, describe, expect, it, vi } from "vitest";

const lane = vi.hoisted(() => ({ lock: vi.fn(), installed: vi.fn(), snapshot: vi.fn(), calculate: vi.fn(), record: vi.fn(), route: vi.fn() }));
const quality = vi.hoisted(() => ({ assert: vi.fn() }));
const sideEffects = vi.hoisted(() => ({ reserve: vi.fn(), audit: vi.fn(), outbox: vi.fn(), action: vi.fn() }));
vi.mock("../../stock/repository/stock-lane-routing.repository", () => ({ lockStockLaneTopology: lane.lock }));
vi.mock("./receipt-lane-assignments.repository", () => ({ assertReceiptLaneAssignmentsInstalled: lane.installed, snapshotReceiptReservations: lane.snapshot, calculateReceiptLaneAssignment: lane.calculate, recordReceiptLaneAssignment: lane.record }));
vi.mock("../../stock/repository/receipt-lane-transfer.repository", () => ({ routeReceiptLaneDistributionTx: lane.route }));
vi.mock("../../qualite/repository/quality-operational-gate.repository", () => ({ assertOperationalLotQualityEligibility: quality.assert }));
vi.mock("./receipt-delivery-reservations.repository", () => ({ reserveProducedDeliveryDemands: sideEffects.reserve }));
vi.mock("./urgency-recovery-receipt.repository", () => ({ reserveUrgencyRecoveryReceiptTx: vi.fn() }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: sideEffects.audit }));
vi.mock("./production-realtime.repository", () => ({ enqueueProductionOfChanged: sideEffects.outbox, productionRealtimeActionFromAudit: sideEffects.action }));

import { reconcileReleasedConsolidationLot } from "./production-receipt-lot-reconciliation.repository";

describe("reconcileReleasedConsolidationLot", () => {
  beforeEach(() => { vi.clearAllMocks(); lane.lock.mockResolvedValue(undefined); lane.installed.mockResolvedValue(undefined); });

  it("leaves a caller-owned transaction untouched when no released receipt exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await reconcileReleasedConsolidationLot({ query } as never, "lot", 7);
    expect(lane.lock).toHaveBeenCalledWith(expect.objectContaining({ query }));
    expect(lane.installed).toHaveBeenCalledWith(expect.objectContaining({ query }));
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("COMMIT");
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
  });

  it("propagates a database failure without taking transaction ownership", async () => {
    const failure = new Error("database unavailable");
    const query = vi.fn().mockRejectedValue(failure);
    await expect(reconcileReleasedConsolidationLot({ query } as never, "lot", 7)).rejects.toBe(failure);
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("COMMIT");
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
  });

  it("allocates a released receipt through the supplied transaction and records audit/outbox", async () => {
    quality.assert.mockResolvedValue({ target: { qty_released: 5, qty_consumed: 0 }, already_committed_qty: 0 });
    lane.snapshot.mockResolvedValue([]); lane.calculate.mockResolvedValue({}); lane.route.mockResolvedValue({ assigned_qty: 5 });
    sideEffects.reserve.mockResolvedValue({ qty_reserved: 5, reservation_ids: ["reservation"] });
    sideEffects.audit.mockResolvedValue({ id: "audit", created_at: "now" }); sideEffects.action.mockReturnValue("changed");
    const receipt = { receipt_id: "receipt", of_id: 3, article_id: "article", location_id: "location", stock_level_id: "level", stock_batch_id: "batch", movement_id: "movement", remaining: "5", order_type: "CLIENT", internal_order_purpose: null, commande_ligne_id: 9, livraison_affaire_id: null, of_status: "EN_COURS" };
    const responses = [[], [receipt], [{ quantity: "0" }], [{ available: "5" }], [], []];
    const query = vi.fn().mockImplementation(() => Promise.resolve({ rows: responses.shift() ?? [] }));
    await reconcileReleasedConsolidationLot({ query } as never, "lot", 7);
    expect(sideEffects.reserve).toHaveBeenCalledWith(expect.objectContaining({ query }), expect.objectContaining({ lot_id: "lot", qty_ok: 5, actor_user_id: 7 }));
    expect(lane.record).toHaveBeenCalledWith(expect.objectContaining({ query }), "receipt", expect.anything(), 7, expect.anything());
    expect(sideEffects.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.objectContaining({ query }), user_id: 7 }));
    expect(sideEffects.outbox).toHaveBeenCalledWith(expect.objectContaining({ query }), expect.objectContaining({ ofId: "3" }));
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("COMMIT");
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
  });
});
