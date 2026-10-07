import { beforeEach, expect, it, vi } from "vitest";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type { AuditContext } from "../repository/production.repository";
vi.mock("../repository/station-cutting.repository", () => ({
  assertCuttingRead: vi.fn(),
  authorizeCuttingTx: vi.fn(),
  assertCuttingTarget: vi.fn(),
  assertCuttingPointageTargetTx: vi.fn(),
}));
vi.mock("./production-execution.service", () => ({
  svcStartExecution: vi.fn(),
  svcPauseExecution: vi.fn(),
  svcResumeExecution: vi.fn(),
  svcStopExecution: vi.fn(),
  svcPreviewFinishOperation: vi.fn(),
  svcFinishOperation: vi.fn(),
}));
import {
  assertCuttingRead,
  assertCuttingTarget,
  authorizeCuttingTx,
  assertCuttingPointageTargetTx,
} from "../repository/station-cutting.repository";
import {
  svcStartExecution,
  svcPauseExecution,
  svcFinishOperation,
} from "./production-execution.service";
import { cuttingExecutionCommandSchema } from "../validators/station-cutting.validators";
import { executeStationCutting } from "./station-cutting-execution.service";

const ofId = 91,
  operationId = "00000000-0000-4000-8000-000000000001";
const station = {
  user: { id: 17, role: "OPERATEUR" },
  machine_id: null,
} as StationContext;
const params = {
  station,
  ofId,
  operationId,
  idempotencyKey: "cutting-fixture-key",
  audit: { user_id: 99, user_role: "ADMIN" } as AuditContext,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCuttingRead).mockResolvedValue(null);
  vi.mocked(assertCuttingTarget).mockResolvedValue(null);
});
it("starts canonical time for the identified operator without a selected machine or JWT identity substitution", async () => {
  const command = cuttingExecutionCommandSchema.parse({
    command: "start",
    payload: {
      of_id: ofId,
      operation_id: operationId,
      activity_code: "PRODUCTION",
    },
  });
  await executeStationCutting({ ...params, command });
  const call = vi.mocked(svcStartExecution).mock.calls[0][0];
  expect(call.actor.id).toBe(17);
  expect(call.audit.user_id).toBe(17);
  expect(call.body.machine_id).toBeNull();
  await call.transactionHooks!.beforeEffect({} as never);
  expect(authorizeCuttingTx).toHaveBeenCalledWith(
    {},
    station,
    ofId,
    operationId,
  );
});
it("resolves an assigned machine on the server and refuses a concurrent assignment change", async () => {
  vi.mocked(assertCuttingRead).mockResolvedValue("operation-machine");
  const command = cuttingExecutionCommandSchema.parse({
    command: "start",
    payload: {
      of_id: ofId,
      operation_id: operationId,
      activity_code: "PRODUCTION",
    },
  });
  await executeStationCutting({ ...params, command });
  const call = vi.mocked(svcStartExecution).mock.calls[0][0];
  expect(call.body.machine_id).toBe("operation-machine");
  await expect(
    call.transactionHooks!.beforeEffect({} as never),
  ).rejects.toMatchObject({ code: "STATION_CUTTING_ASSIGNMENT_CHANGED" });
});
it("guards the exact own OF pointage before a pause effect or replay", async () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const command = cuttingExecutionCommandSchema.parse({
    command: "pause",
    payload: { id, payload: {} },
  });
  await executeStationCutting({ ...params, command });
  await vi
    .mocked(svcPauseExecution)
    .mock.calls[0][0].transactionHooks!.beforeEffect({} as never);
  expect(assertCuttingPointageTargetTx).toHaveBeenCalledWith(
    {},
    station,
    ofId,
    operationId,
    id,
  );
});
it("does not accept a submitted operator, another OF or duplicate quantities at finish", async () => {
  expect(
    cuttingExecutionCommandSchema.safeParse({
      command: "start",
      payload: {
        of_id: ofId,
        operation_id: operationId,
        activity_code: "PRODUCTION",
        operator_user_id: 99,
      },
    }).success,
  ).toBe(false);
  expect(
    cuttingExecutionCommandSchema.safeParse({
      command: "finish",
      payload: {
        of_id: ofId,
        operation_id: operationId,
        qty_good: 1,
        complete_operation: true,
        preview_hash: "a".repeat(64),
      },
    }).success,
  ).toBe(false);
  const command = cuttingExecutionCommandSchema.parse({
    command: "start",
    payload: {
      of_id: 92,
      operation_id: operationId,
      activity_code: "PRODUCTION",
    },
  });
  await expect(
    executeStationCutting({ ...params, command }),
  ).rejects.toMatchObject({ code: "STATION_CUTTING_OPERATION_CONFLICT" });
  expect(svcStartExecution).not.toHaveBeenCalled();
  const finish = cuttingExecutionCommandSchema.parse({
    command: "finish",
    payload: {
      of_id: ofId,
      operation_id: operationId,
      complete_operation: true,
      preview_hash: "a".repeat(64),
    },
  });
  await executeStationCutting({ ...params, command: finish });
  expect(
    vi.mocked(svcFinishOperation).mock.calls[0][0].transactionHooks,
  ).toBeDefined();
});
