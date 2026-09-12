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
  repoInsertAnomaly: vi.fn(),
  insertAuditLog: vi.fn(),
  repoInsertTimeEvent: vi.fn(),
  repoListEventsForDay: vi.fn().mockResolvedValue([]),
  repoRefreshDayAnomalies: vi.fn(),
  repoUpsertTimesheetDay: vi.fn(),
  repoListAnomalies: vi.fn().mockResolvedValue([]),
}));

import * as repo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import { createTimeEvent } from "../module/temps-deplacements/services/temps-deplacements.service";

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
});
