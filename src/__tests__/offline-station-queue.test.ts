import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";
import { repoRoot } from "./helpers/repo-paths";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  assertClaim: vi.fn(),
  releaseClaim: vi.fn(),
  dependency: vi.fn(),
  sourceSession: vi.fn(),
  canonicalExists: vi.fn(),
  purge: vi.fn(),
  audit: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  quantity: vi.fn(),
}));

vi.mock("../module/production/repository/offline-station.repository", () => ({
  repoOfflineSyncEnabled: mocks.enabled,
  repoReserveOfflineEvent: mocks.reserve,
  repoCompleteOfflineEvent: mocks.complete,
  repoAssertOfflineEventClaim: mocks.assertClaim,
  repoReleaseOfflineEventClaim: mocks.releaseClaim,
  repoOfflineDependency: mocks.dependency,
  repoOfflineSourceSession: mocks.sourceSession,
  repoCanonicalIdempotencyExists: mocks.canonicalExists,
  repoPurgeOfflineEvents: mocks.purge,
}));
vi.mock("../module/production/repository/station.repository", () => ({ repoStationAudit: mocks.audit }));
vi.mock("../module/production/services/production-execution.service", () => ({
  svcStartExecution: mocks.start,
  svcStopExecution: mocks.stop,
  svcDeclareQuantity: mocks.quantity,
}));

import { svcSyncOfflineStation } from "../module/production/services/offline-station.service";
import { offlineStationSyncSchema } from "../module/production/validators/offline-station.validators";

const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD_SESSION = "abababab-abab-4bab-8bab-abababababab";
const MACHINE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD_MACHINE = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const EVENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STOP_EVENT = "12121212-1212-4121-8121-121212121212";
const ENTITY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const station = {
  session_id: SESSION,
  device_id: DEVICE,
  device_code: "TAB-0001",
  device_zone: "USINAGE",
  device_assignment_mode: "FIXED" as const,
  machine_id: MACHINE,
  user: { id: 7, username: "operator", name: null, surname: null, role: "Operateur CN" },
  auto_lock_seconds: 180,
};
const audit = {
  user_id: 7,
  user_role: "Operateur CN",
  ip: null,
  user_agent: null,
  device_type: "tablet",
  os: null,
  browser: null,
  path: "/api/v1/production/station/offline/sync",
  page_key: "atelier-offline-sync",
  client_session_id: SESSION,
};

function startBatch(overrides: Record<string, unknown> = {}) {
  return offlineStationSyncSchema.parse({
    client_batch_id: BATCH,
    events: [{
      event_id: EVENT,
      idempotency_key: "offline-start-000001",
      type: "POINTAGE_START",
      occurred_at: new Date().toISOString(),
      device_id: DEVICE,
      user_id: 7,
      station_session_id: SESSION,
      machine_id: MACHINE,
      payload: { of_id: 42, activity_code: "PRODUCTION" },
      ...overrides,
    }],
  });
}

function stopBatch(overrides: Record<string, unknown> = {}) {
  return offlineStationSyncSchema.parse({
    client_batch_id: BATCH,
    events: [{
      event_id: STOP_EVENT,
      idempotency_key: "offline-stop-000001",
      type: "POINTAGE_STOP",
      occurred_at: new Date().toISOString(),
      device_id: DEVICE,
      user_id: 7,
      station_session_id: SESSION,
      machine_id: MACHINE,
      payload: { pointage_id: null, start_event_id: EVENT },
      ...overrides,
    }],
  });
}

function quantityBatch(payloadOverrides: Record<string, unknown> = {}) {
  return offlineStationSyncSchema.parse({
    client_batch_id: BATCH,
    events: [{
      event_id: STOP_EVENT,
      idempotency_key: "offline-quantity-0001",
      type: "QUANTITY_DECLARE",
      occurred_at: new Date().toISOString(),
      device_id: DEVICE,
      user_id: 7,
      station_session_id: SESSION,
      machine_id: MACHINE,
      payload: { of_id: 42, qty_good: 1, ...payloadOverrides },
    }],
  });
}

function processing(existing = false) {
  return {
    kind: "RESERVED" as const,
    existing,
    outcome: {
      event_id: EVENT,
      status: "PROCESSING" as const,
      result_payload: null,
      error_code: null,
      error_message: null,
      server_entity_id: null,
    },
  };
}

function syncedStartDependency(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EVENT,
    status: "SYNCED" as const,
    result_payload: { server_entity_id: ENTITY },
    error_code: null,
    error_message: null,
    server_entity_id: ENTITY,
    execution_session_id: null,
    client_batch_id: BATCH,
    event_type: "POINTAGE_START" as const,
    device_id: DEVICE,
    operator_user_id: 7,
    station_session_id: SESSION,
    machine_id: MACHINE,
    ...overrides,
  };
}

function currentSyncedStartDependency(overrides: Record<string, unknown> = {}) {
  return syncedStartDependency({
    execution_session_id: mocks.reserve.mock.calls.at(-1)?.[0].executionSessionId ?? null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STATION_OFFLINE_SYNC_ENABLED;
  mocks.enabled.mockResolvedValue(true);
  mocks.reserve.mockResolvedValue(processing());
  mocks.complete.mockResolvedValue(undefined);
  mocks.assertClaim.mockResolvedValue(undefined);
  mocks.releaseClaim.mockResolvedValue(undefined);
  mocks.canonicalExists.mockResolvedValue(false);
  mocks.sourceSession.mockResolvedValue({
    id: SESSION,
    device_id: DEVICE,
    user_id: 7,
    machine_id: MACHINE,
    state: "ACTIVE",
    started_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    closed_at: null,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  mocks.purge.mockResolvedValue(0);
  mocks.audit.mockResolvedValue(undefined);
  const runCanonical = async (params: {
    transactionHooks?: {
      beforeEffect: (tx: { query: ReturnType<typeof vi.fn> }) => Promise<void>;
      beforeCommit: (tx: { query: ReturnType<typeof vi.fn> }, result: { id: string }) => Promise<void>;
    };
  }) => {
    const tx = { query: vi.fn() };
    await params.transactionHooks?.beforeEffect(tx);
    await params.transactionHooks?.beforeCommit(tx, { id: ENTITY });
    return { id: ENTITY };
  };
  mocks.start.mockImplementation(runCanonical);
  mocks.stop.mockImplementation(runCanonical);
  mocks.quantity.mockImplementation(runCanonical);
});

describe("GPT56-FEAT-CERP-0006 — contrat borné", () => {
  it("n'accepte que les trois événements et 25 éléments au maximum", () => {
    expect(startBatch().events[0]?.type).toBe("POINTAGE_START");
    expect(() => startBatch({ type: "QUALITY_RELEASE" })).toThrow();
    expect(() => startBatch({ occurred_at: "2026-08-05" })).toThrow();
    const one = startBatch().events[0];
    expect(() => offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: Array.from({ length: 26 }, (_, index) => ({
        ...one,
        event_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        idempotency_key: `offline-${index}-unique`,
      })),
    })).toThrow();
  });

  it("refuse les doublons internes et une quantité nulle", () => {
    const event = startBatch().events[0];
    expect(() => offlineStationSyncSchema.parse({ client_batch_id: BATCH, events: [event, event] })).toThrow();
    expect(() => offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: [{
        ...event,
        type: "QUANTITY_DECLARE",
        payload: { of_id: 42, qty_good: 0 },
      }],
    })).toThrow();
  });

  it("canonicalise tous les UUID avant réservation et recherche de dépendance", async () => {
    const event = stopBatch().events[0]!;
    const uppercaseEventId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
    const canonicalEventId = uppercaseEventId.toLowerCase();
    const body = offlineStationSyncSchema.parse({
      client_batch_id: BATCH.toUpperCase(),
      events: [{
        ...event,
        event_id: uppercaseEventId,
        device_id: DEVICE.toUpperCase(),
        station_session_id: SESSION.toUpperCase(),
        machine_id: MACHINE.toUpperCase(),
        payload: { pointage_id: null, start_event_id: EVENT.toUpperCase() },
      }],
    });
    mocks.dependency.mockImplementation(() => Promise.resolve(currentSyncedStartDependency()));

    const result = await svcSyncOfflineStation({ body, station, audit });

    expect(body.client_batch_id).toBe(BATCH);
    expect(body.events[0]).toMatchObject({
      event_id: canonicalEventId,
      device_id: DEVICE,
      station_session_id: SESSION,
      machine_id: MACHINE,
      payload: { start_event_id: EVENT },
    });
    expect(mocks.reserve.mock.calls[0]?.[0].event.event_id).toBe(canonicalEventId);
    expect(mocks.dependency).toHaveBeenCalledWith(EVENT);
    expect(result.results[0]).toMatchObject({ status: "SYNCED" });
  });

  it("double sync: applique une fois puis renvoie le reçu synchronisé", async () => {
    mocks.reserve
      .mockResolvedValueOnce(processing())
      .mockResolvedValueOnce({
        kind: "RESERVED",
        existing: true,
        outcome: {
          event_id: EVENT,
          status: "SYNCED",
          result_payload: { server_entity_id: ENTITY },
          error_code: null,
          error_message: null,
          server_entity_id: ENTITY,
        },
      });
    const body = startBatch();
    const first = await svcSyncOfflineStation({ body, station, audit });
    const second = await svcSyncOfflineStation({ body, station, audit });
    expect(first.results[0]).toMatchObject({ status: "SYNCED", replayed: false, server_entity_id: ENTITY });
    expect(second.results[0]).toMatchObject({ status: "SYNCED", replayed: true, server_entity_id: ENTITY });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("rejoue un reçu SYNCED terminal avant tout contrôle volatil d'horloge ou de session source", async () => {
    mocks.reserve.mockResolvedValue({
      kind: "RESERVED",
      existing: true,
      outcome: {
        ...processing().outcome,
        status: "SYNCED",
        server_entity_id: ENTITY,
      },
    });
    const result = await svcSyncOfflineStation({
      body: startBatch({
        occurred_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        station_session_id: OLD_SESSION,
        machine_id: OLD_MACHINE,
      }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({ status: "SYNCED", server_entity_id: ENTITY, replayed: true });
    expect(mocks.sourceSession).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("résout un STOP vers le START local synchronisé juste avant dans le même lot", async () => {
    const start = startBatch().events[0]!;
    const body = offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: [
        start,
        {
          event_id: STOP_EVENT,
          idempotency_key: "offline-stop-000001",
          type: "POINTAGE_STOP",
          occurred_at: new Date().toISOString(),
          device_id: DEVICE,
          user_id: 7,
          station_session_id: SESSION,
          machine_id: MACHINE,
          payload: { pointage_id: null, start_event_id: EVENT },
        },
      ],
    });
    mocks.reserve.mockImplementation(({ event }: { event: { event_id: string } }) => Promise.resolve({
      ...processing(),
      outcome: { ...processing().outcome, event_id: event.event_id },
    }));
    mocks.dependency.mockImplementation(() => Promise.resolve(currentSyncedStartDependency()));
    mocks.stop.mockResolvedValue({ id: ENTITY });
    const result = await svcSyncOfflineStation({ body, station, audit });
    expect(result.results.map((item) => item.status)).toEqual(["SYNCED", "SYNCED"]);
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ id: ENTITY }));
    expect(mocks.reserve.mock.calls[0]?.[0].executionSessionId).toEqual(expect.any(String));
    expect(mocks.reserve.mock.calls[1]?.[0].executionSessionId).toBe(
      mocks.reserve.mock.calls[0]?.[0].executionSessionId
    );
  });

  it.each([
    ["type", { event_type: "QUANTITY_DECLARE" }, "OFFLINE_DEPENDENCY_TYPE_INVALID"],
    ["lot", { client_batch_id: "10101010-1010-4010-8010-101010101010" }, "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT"],
    ["appareil", { device_id: "20202020-2020-4020-8020-202020202020" }, "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT"],
    ["opérateur", { operator_user_id: 8 }, "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT"],
    ["session", { station_session_id: OLD_SESSION }, "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT"],
    ["machine", { machine_id: OLD_MACHINE }, "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT"],
  ])("refuse un start_event_id dont le %s diffère", async (_label, dependencyOverride, code) => {
    mocks.dependency.mockImplementation(() => Promise.resolve(currentSyncedStartDependency(dependencyOverride)));
    const result = await svcSyncOfflineStation({ body: stopBatch(), station, audit });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("résout aussi start_event_id pour une déclaration de quantité", async () => {
    mocks.dependency.mockImplementation(() => Promise.resolve(currentSyncedStartDependency()));
    mocks.quantity.mockResolvedValue({ id: ENTITY });
    const result = await svcSyncOfflineStation({
      body: quantityBatch({ pointage_id: null, start_event_id: EVENT }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({ status: "SYNCED", server_entity_id: ENTITY });
    expect(mocks.quantity).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ pointage_id: ENTITY }),
    }));
    expect(mocks.quantity.mock.calls[0]?.[0].body).not.toHaveProperty("start_event_id");
  });

  it("autorise une quantité sans pointage mais jamais deux références", () => {
    expect(quantityBatch({ pointage_id: null, start_event_id: null }).events[0]?.type).toBe("QUANTITY_DECLARE");
    expect(() => quantityBatch({ pointage_id: ENTITY, start_event_id: EVENT })).toThrow();
  });

  it.each([
    ["absente", null, "OFFLINE_DEPENDENCY_MISSING"],
    ["encore en cours", "PROCESSING", "OFFLINE_DEPENDENCY_PENDING"],
  ])("laisse une dépendance START %s rejouable sans reçu REJECTED", async (_label, dependencyStatus, code) => {
    if (dependencyStatus) {
      mocks.dependency.mockImplementation(() => Promise.resolve(currentSyncedStartDependency({
        status: dependencyStatus,
        server_entity_id: null,
      })));
    } else {
      mocks.dependency.mockResolvedValue(null);
    }
    await expect(svcSyncOfflineStation({ body: stopBatch(), station, audit })).rejects.toMatchObject({
      status: 503,
      code,
    });
    expect(mocks.releaseClaim).toHaveBeenCalledWith(expect.objectContaining({
      eventId: STOP_EVENT,
      claimToken: expect.any(String),
    }));
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("synchronise le STOP au retry dès que son START intermittent est disponible", async () => {
    mocks.reserve.mockResolvedValueOnce(processing()).mockResolvedValueOnce(processing(true));
    mocks.dependency
      .mockResolvedValueOnce(null)
      .mockImplementation(() => Promise.resolve(currentSyncedStartDependency()));
    await expect(svcSyncOfflineStation({ body: stopBatch(), station, audit })).rejects.toMatchObject({
      status: 503,
      code: "OFFLINE_DEPENDENCY_MISSING",
    });
    const result = await svcSyncOfflineStation({ body: stopBatch(), station, audit });
    expect(result.results[0]).toMatchObject({ status: "SYNCED", server_entity_id: ENTITY, replayed: true });
    expect(mocks.releaseClaim).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("continue le lot après une dépendance transitoire pour laisser arriver son START", async () => {
    const stop = stopBatch().events[0]!;
    const start = startBatch().events[0]!;
    const body = offlineStationSyncSchema.parse({ client_batch_id: BATCH, events: [stop, start] });
    mocks.reserve.mockImplementation(({ event }: { event: { event_id: string } }) => Promise.resolve({
      ...processing(),
      outcome: { ...processing().outcome, event_id: event.event_id },
    }));
    mocks.dependency.mockResolvedValue(null);
    await expect(svcSyncOfflineStation({ body, station, audit })).rejects.toMatchObject({
      status: 503,
      code: "OFFLINE_DEPENDENCY_MISSING",
    });
    expect(mocks.releaseClaim).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT, status: "SYNCED" }),
      expect.anything()
    );
  });

  it("verrouille le fencing avant l'effet puis finalise le reçu dans la même transaction", async () => {
    const order: string[] = [];
    const tx = { query: vi.fn() };
    mocks.assertClaim.mockImplementation(async () => { order.push("claim"); });
    mocks.complete.mockImplementation(async () => { order.push("receipt"); });
    mocks.start.mockImplementation(async (params: {
      transactionHooks: {
        beforeEffect: (client: typeof tx) => Promise<void>;
        beforeCommit: (client: typeof tx, result: { id: string }) => Promise<void>;
      };
    }) => {
      await params.transactionHooks.beforeEffect(tx);
      order.push("effect");
      await params.transactionHooks.beforeCommit(tx, { id: ENTITY });
      return { id: ENTITY };
    });
    await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(order).toEqual(["claim", "effect", "receipt"]);
    expect(mocks.assertClaim.mock.calls[0]?.[0]).toBe(tx);
    expect(mocks.complete.mock.calls[0]?.[1]).toBe(tx);
  });

  it("annule effet et reçu ensemble si la finalisation atomique échoue, puis reprend avec un nouveau token", async () => {
    mocks.reserve.mockResolvedValueOnce(processing()).mockResolvedValueOnce(processing(true));
    mocks.complete.mockRejectedValueOnce(new Error("atomic finalization failed")).mockResolvedValueOnce(undefined);
    mocks.canonicalExists.mockResolvedValue(false);
    await expect(svcSyncOfflineStation({ body: startBatch(), station, audit })).rejects.toThrow("atomic finalization failed");
    const resumed = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(resumed.results[0]).toMatchObject({ status: "SYNCED", replayed: true });
    expect(mocks.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: "offline-start-000001" }));
    const firstClaim = mocks.reserve.mock.calls[0]?.[0].claimToken;
    const resumedClaim = mocks.reserve.mock.calls[1]?.[0].claimToken;
    expect(firstClaim).toEqual(expect.any(String));
    expect(resumedClaim).toEqual(expect.any(String));
    expect(resumedClaim).not.toBe(firstClaim);
    expect(mocks.reserve.mock.calls[1]?.[0].executionSessionId).toBe(
      mocks.reserve.mock.calls[0]?.[0].executionSessionId
    );
    expect(mocks.start.mock.calls[1]?.[0].executionSessionId).toBe(
      mocks.start.mock.calls[0]?.[0].executionSessionId
    );
    expect(mocks.complete.mock.calls[0]?.[0].claimToken).toBe(firstClaim);
    expect(mocks.complete.mock.calls[1]?.[0].claimToken).toBe(resumedClaim);
  });

  it("rend les conflits explicites et persistants", async () => {
    mocks.start.mockRejectedValue(new HttpError(409, "PRODUCTION_EXECUTION_OVERLAP", "Chevauchement détecté."));
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result.results[0]).toMatchObject({
      status: "REJECTED",
      code: "PRODUCTION_EXECUTION_OVERLAP",
      message: "Chevauchement détecté.",
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
  });

  it("n'écrase jamais une collision d'identifiant ou de clé", async () => {
    mocks.reserve.mockResolvedValue({ kind: "CONFLICT" });
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_IDEMPOTENCY_CONFLICT" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("réserve et fige un rejet d'identité avant tout effet canonique", async () => {
    mocks.reserve
      .mockResolvedValueOnce(processing())
      .mockResolvedValueOnce({
        kind: "RESERVED",
        existing: true,
        outcome: {
          ...processing().outcome,
          status: "REJECTED",
          error_code: "OFFLINE_OPERATOR_CONFLICT",
          error_message: "Identité refusée.",
        },
      });
    const body = startBatch({ user_id: 8 });
    const first = await svcSyncOfflineStation({ body, station, audit });
    const retry = await svcSyncOfflineStation({ body, station, audit });
    expect(first.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_OPERATOR_CONFLICT", replayed: false });
    expect(retry.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_OPERATOR_CONFLICT", replayed: true });
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED", claimToken: expect.any(String) }));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("reprend après réauthentification si la session source prouve le même opérateur et appareil", async () => {
    const occurredAt = new Date();
    mocks.sourceSession.mockResolvedValue({
      id: OLD_SESSION,
      device_id: DEVICE,
      user_id: 7,
      machine_id: OLD_MACHINE,
      state: "CLOSED",
      started_at: new Date(occurredAt.getTime() - 3_600_000).toISOString(),
      closed_at: new Date(occurredAt.getTime() + 1_000).toISOString(),
      expires_at: new Date(occurredAt.getTime() + 7_200_000).toISOString(),
    });
    const result = await svcSyncOfflineStation({
      body: startBatch({
        station_session_id: OLD_SESSION,
        machine_id: OLD_MACHINE,
        occurred_at: occurredAt.toISOString(),
      }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({ status: "SYNCED", server_entity_id: ENTITY });
    expect(mocks.sourceSession).toHaveBeenCalledWith(OLD_SESSION);
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      executionSessionId: expect.any(String),
      body: expect.objectContaining({ machine_id: OLD_MACHINE }),
    }));
    const executionId = mocks.start.mock.calls[0]?.[0].executionSessionId;
    expect(executionId).toBe(mocks.reserve.mock.calls[0]?.[0].executionSessionId);
    expect(executionId).not.toBe(SESSION);
    expect(executionId).not.toBe(OLD_SESSION);
  });

  it("refuse aussi l'antidatage antérieur à l'ouverture de la session courante", async () => {
    const startedAt = new Date();
    mocks.sourceSession.mockResolvedValue({
      id: SESSION,
      device_id: DEVICE,
      user_id: 7,
      machine_id: MACHINE,
      state: "ACTIVE",
      started_at: startedAt.toISOString(),
      closed_at: null,
      expires_at: new Date(startedAt.getTime() + 8 * 3_600_000).toISOString(),
    });
    const result = await svcSyncOfflineStation({
      body: startBatch({ occurred_at: new Date(startedAt.getTime() - 61_000).toISOString() }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({
      status: "REJECTED",
      code: "OFFLINE_SOURCE_SESSION_TIME_CONFLICT",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("fige le rejet si la session source ne correspond pas au contexte déclaré", async () => {
    mocks.sourceSession.mockResolvedValue({
      id: OLD_SESSION,
      device_id: DEVICE,
      user_id: 99,
      machine_id: OLD_MACHINE,
      state: "CLOSED",
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      closed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await svcSyncOfflineStation({
      body: startBatch({ station_session_id: OLD_SESSION, machine_id: OLD_MACHINE }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_SOURCE_SESSION_CONFLICT" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuse un événement hors de la fenêtre de sa session source", async () => {
    const occurredAt = new Date();
    mocks.sourceSession.mockResolvedValue({
      id: OLD_SESSION,
      device_id: DEVICE,
      user_id: 7,
      machine_id: OLD_MACHINE,
      state: "CLOSED",
      started_at: new Date(occurredAt.getTime() - 7_200_000).toISOString(),
      closed_at: new Date(occurredAt.getTime() - 120_000).toISOString(),
      expires_at: new Date(occurredAt.getTime() + 3_600_000).toISOString(),
    });
    const result = await svcSyncOfflineStation({
      body: startBatch({
        station_session_id: OLD_SESSION,
        machine_id: OLD_MACHINE,
        occurred_at: occurredAt.toISOString(),
      }),
      station,
      audit,
    });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_SOURCE_SESSION_TIME_CONFLICT" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
  });

  it("rejette explicitement une horloge trop en avance ou un événement expiré", async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    mocks.reserve
      .mockResolvedValueOnce(processing())
      .mockResolvedValueOnce({
        kind: "RESERVED",
        existing: true,
        outcome: {
          ...processing().outcome,
          status: "REJECTED",
          error_code: "OFFLINE_CLOCK_AHEAD",
          error_message: "Horloge refusée.",
        },
      })
      .mockResolvedValueOnce({
        ...processing(),
        outcome: { ...processing().outcome, event_id: STOP_EVENT },
      });
    const futureBody = startBatch({ occurred_at: future });
    const ahead = await svcSyncOfflineStation({ body: futureBody, station, audit });
    const aheadRetry = await svcSyncOfflineStation({ body: futureBody, station, audit });
    const expired = await svcSyncOfflineStation({
      body: startBatch({ occurred_at: old, event_id: STOP_EVENT, idempotency_key: "offline-start-expired-1" }),
      station,
      audit,
    });
    expect(ahead.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_CLOCK_AHEAD" });
    expect(aheadRetry.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_CLOCK_AHEAD", replayed: true });
    expect(expired.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_EVENT_EXPIRED" });
    expect(mocks.reserve).toHaveBeenCalledTimes(3);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("le kill switch ne consomme aucun événement", async () => {
    mocks.enabled.mockResolvedValue(false);
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result).toMatchObject({ kill_switch_enabled: true, results: [] });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("refuse temporairement une synchronisation concurrente sans marquer l'événement rejeté", async () => {
    mocks.reserve.mockResolvedValue({ kind: "BUSY" });
    await expect(svcSyncOfflineStation({ body: startBatch(), station, audit })).rejects.toMatchObject({
      status: 503,
      code: "OFFLINE_EVENT_IN_PROGRESS",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe("GPT56-FEAT-CERP-0006 — migration et frontières", () => {
  const patchDir = path.join(repoRoot, "db", "patches");
  const migration = fs.readFileSync(path.join(patchDir, "20260805_station_offline_queue_0006.sql"), "utf8");
  const repository = fs.readFileSync(
    path.join(repoRoot, "src", "module", "production", "repository", "offline-station.repository.ts"),
    "utf8"
  );
  const canonicalRepository = fs.readFileSync(
    path.join(repoRoot, "src", "module", "production", "repository", "production-execution.repository.ts"),
    "utf8"
  );

  it("fournit migration, preflight, vérification et rollback test-only", () => {
    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.join(patchDir, "support", `20260805_station_offline_queue_0006.${suffix}.sql`))).toBe(true);
    }
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    const rollback = fs.readFileSync(path.join(patchDir, "support", "20260805_station_offline_queue_0006.rollback.sql"), "utf8");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("offline receipt data exists");
  });

  it("ne crée ni effet stock/qualité ni secret persistant", () => {
    expect(migration).not.toMatch(/INSERT INTO public\.(stock_|lots|quality_|production_receipts)/i);
    expect(migration).not.toMatch(/\b(session_token|badge_uid|password|enrollment_secret)\s+(text|bytea)\b/i);
    expect(migration).toContain("POINTAGE_START");
    expect(migration).toContain("QUANTITY_DECLARE");
  });

  it("rend les reçus finaux immuables et fournit purge et kill switch", () => {
    expect(migration).toContain("Final offline receipts are immutable");
    expect(migration).toContain("fn_purge_production_station_offline_events");
    expect(migration).toContain("production_station_offline_config");
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.production_station_offline_config TO cerp_app/);
  });

  it("sépare les déclarations clientes de l'identité authentifiée persistée", () => {
    expect(migration).toContain("authenticated_station_session_id uuid NOT NULL");
    expect(migration).toContain("FOREIGN KEY (authenticated_device_id)");
    expect(migration).toContain("FOREIGN KEY (authenticated_operator_user_id)");
    expect(migration).not.toMatch(/FOREIGN KEY \(device_id\)/);
    expect(migration).not.toMatch(/FOREIGN KEY \(operator_user_id\)/);
    expect(migration).toContain("NEW.authenticated_station_session_id IS DISTINCT FROM OLD.authenticated_station_session_id");
  });

  it("fence chaque reprise et interdit à un ancien propriétaire de finaliser", () => {
    expect(migration).toContain("processing_token uuid NOT NULL");
    expect(migration).toContain("lease_expires_at timestamptz NOT NULL");
    expect(repository).toContain("processing_token = $2::uuid");
    expect(repository).toContain("lease_expires_at > clock_timestamp()");
    expect(repository).toContain("processing_token = $8::uuid");
    expect(repository).toContain("result.rowCount !== 1");
  });

  it("verrouille le reçu avant chaque transaction canonique et le finalise avant COMMIT", () => {
    expect(repository).toMatch(/repoAssertOfflineEventClaim[\s\S]*FOR UPDATE/);
    expect(repository).toContain("lease_expires_at > clock_timestamp()");
    for (const functionName of ["repoStartExecution", "repoStopExecution", "repoDeclareQuantity"]) {
      const start = canonicalRepository.indexOf(`export async function ${functionName}`);
      const end = canonicalRepository.indexOf("\nexport async function ", start + 1);
      const body = canonicalRepository.slice(start, end === -1 ? undefined : end);
      expect(body.indexOf("beforeEffect(client)")).toBeGreaterThan(-1);
      expect(body.indexOf("beforeEffect(client)")).toBeLessThan(body.indexOf("reserveIdempotencyKey"));
      expect(body.lastIndexOf("beforeCommit(client")).toBeGreaterThan(body.indexOf("storeIdempotentResponse"));
      expect(body.lastIndexOf("beforeCommit(client")).toBeLessThan(body.lastIndexOf('client.query("COMMIT")'));
    }
  });

  it("porte une session d'exécution stable distincte de la session d'authentification", () => {
    expect(migration).toContain("execution_session_id uuid");
    expect(migration).toContain("event_type <> 'POINTAGE_START' OR execution_session_id IS NOT NULL");
    expect(migration).toContain("NEW.execution_session_id IS DISTINCT FROM OLD.execution_session_id");
  });
});
