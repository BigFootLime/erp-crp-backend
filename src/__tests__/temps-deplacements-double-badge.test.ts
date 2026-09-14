import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/domain/temps-deplacements-policy", () => ({ assertPeriodOpen: vi.fn() }));
vi.mock("../module/temps-deplacements/repository/temps-deplacements-rules.repository", () => ({
  repoGetEffectiveRuleSet: vi.fn().mockResolvedValue(null),
  repoUpsertTimesheetWeek: vi.fn(),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements-operations.repository", () => ({
  repoSumApprovedAbsenceMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({ query: vi.fn() })),
  repoFindEventByIdempotencyKey: vi.fn(),
  repoLockEmployeeTimeEvents: vi.fn(),
  repoGetLastEvent: vi.fn(),
  repoGetLastAttendanceEvent: vi.fn(),
  repoInsertAnomaly: vi.fn(),
  insertAuditLog: vi.fn(),
  repoInsertTimeEvent: vi.fn(),
  repoListEventsForDay: vi.fn().mockResolvedValue([]),
  repoRefreshDayAnomalies: vi.fn(),
  repoUpsertTimesheetDay: vi.fn(),
  repoListAnomalies: vi.fn().mockResolvedValue([]),
}));

import * as repo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import { createTimeEvent, resolveAutomaticEventType } from "../module/temps-deplacements/services/temps-deplacements.service";

const mockedRepo = vi.mocked(repo);
const employeeId = "11111111-1111-4111-8111-111111111111";
const previous = {
  id: "event-1",
  employee_id: employeeId,
  device_id: "device-1",
  event_type: "IN" as const,
  event_time: "2026-09-12T06:00:00.000Z",
  source: "BADGE" as const,
  created_at: "2026-09-12T06:00:00.000Z",
};
const audit = { user_id: null, ip: null, user_agent: null, device_type: "KIOSK", os: null, browser: null, path: null, page_key: null, client_session_id: null };

beforeEach(() => vi.clearAllMocks());

describe("pointage — anti-double scan physique", () => {
  it("ignore deux scans IN rapprochés même si leurs clés d'idempotence diffèrent", async () => {
    mockedRepo.repoFindEventByIdempotencyKey.mockResolvedValue(null);
    mockedRepo.repoGetLastEvent.mockResolvedValue(previous);

    const result = await createTimeEvent({
      employee_id: employeeId,
      device_id: "device-1",
      event_type: "IN",
      event_time: "2026-09-12T06:00:30.000Z",
      source: "BADGE",
      idempotency_key: "another-scan-id",
    }, audit);

    expect(result).toMatchObject({ event: previous, deduplicated: true, double_badge: true });
    expect(mockedRepo.repoLockEmployeeTimeEvents).toHaveBeenCalledWith(employeeId, expect.anything());
    expect(mockedRepo.repoInsertTimeEvent).not.toHaveBeenCalled();
  });

  it("renvoie directement l'événement d'un retry ayant exactement la même clé", async () => {
    mockedRepo.repoFindEventByIdempotencyKey.mockResolvedValue(previous);
    const result = await createTimeEvent({
      employee_id: employeeId,
      event_type: "IN",
      source: "BADGE",
      idempotency_key: "same-scan-id",
    }, audit);

    expect(result).toMatchObject({ event: previous, deduplicated: true, double_badge: false });
    expect(mockedRepo.repoLockEmployeeTimeEvents).not.toHaveBeenCalled();
  });

  it("ignore un second scan AUTO rapproché au lieu de transformer l'entrée en sortie", async () => {
    mockedRepo.repoFindEventByIdempotencyKey.mockResolvedValue(null);
    mockedRepo.repoGetLastAttendanceEvent.mockResolvedValue(previous);

    const result = await createTimeEvent({
      employee_id: employeeId,
      device_id: "device-1",
      event_type: "AUTO",
      event_time: "2026-09-12T06:00:30.000Z",
      source: "BADGE",
      idempotency_key: "auto-second-scan",
    }, audit);

    expect(result).toMatchObject({ event: previous, deduplicated: true, double_badge: true });
    expect(mockedRepo.repoInsertTimeEvent).not.toHaveBeenCalled();
  });
});

describe("pointage automatique entrée / sortie", () => {
  it("commence par une entrée et alterne ensuite", () => {
    expect(resolveAutomaticEventType(null, "2026-09-12T06:00:00.000Z")).toBe("IN");
    expect(resolveAutomaticEventType(previous, "2026-09-12T15:00:00.000Z")).toBe("OUT");
    expect(resolveAutomaticEventType({ ...previous, event_type: "OUT" }, "2026-09-12T15:00:00.000Z")).toBe("IN");
  });

  it("repart sur une entrée au changement de journée Paris", () => {
    expect(resolveAutomaticEventType(previous, "2026-09-13T06:00:00.000Z")).toBe("IN");
  });

  it("persiste le type résolu et jamais la valeur AUTO", async () => {
    mockedRepo.repoFindEventByIdempotencyKey.mockResolvedValue(null);
    mockedRepo.repoGetLastAttendanceEvent.mockResolvedValue(previous);
    mockedRepo.repoInsertTimeEvent.mockImplementation(async (_client, input) => ({
      event: { ...previous, id: "event-2", event_type: input.event_type, event_time: input.event_time ?? previous.event_time },
      deduplicated: false,
    }));

    const result = await createTimeEvent({
      employee_id: employeeId,
      device_id: "device-1",
      event_type: "AUTO",
      event_time: "2026-09-12T15:00:00.000Z",
      source: "BADGE",
      idempotency_key: "auto-out-scan",
    }, audit);

    expect(mockedRepo.repoInsertTimeEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event_type: "OUT" }));
    expect(result.event.event_type).toBe("OUT");
  });
});
