import { expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { StationContext } from "../middlewares/station-authorization.middleware";
vi.mock("../../../config/database", () => ({ default: { query: vi.fn() } }));
import {
  authorizeCuttingTx,
  cuttingPointageTx,
} from "./station-cutting.repository";
const station = {
  session_id: "session",
  device_id: "device",
  machine_id: "machine",
  user: { id: 17 },
  auto_lock_seconds: 180,
} as StationContext;
function tx(rows: unknown[][]) {
  return {
    query: vi
      .fn()
      .mockImplementation(async () => ({ rows: rows.shift() ?? [] })),
  } as unknown as PoolClient;
}
it("refuses a revoked device before reading a target or performing material effects", async () => {
  const t = tx([[{ id: 17 }], [{ status: "REVOKED" }]]);
  await expect(authorizeCuttingTx(t, station, 91, "op")).rejects.toMatchObject({
    code: "STATION_DEVICE_DISABLED",
  });
  expect(t.query).toHaveBeenCalledTimes(2);
  expect(t.query).not.toHaveBeenCalledWith(expect.stringContaining("FROM public.of_operations"), expect.anything());
});
it("refuses a locked or changed session even for an idempotent transport retry", async () => {
  for (const session of [
    { usable: false, user_id: 17, machine_id: "machine" },
    { usable: true, user_id: 18, machine_id: "machine" },
    { usable: true, user_id: 17, machine_id: "other" },
  ]) {
    await expect(
      authorizeCuttingTx(
        tx([[{ id: 17 }], [{ status: "ACTIVE" }], [session]]),
        station,
        91,
        "op",
      ),
    ).rejects.toMatchObject({ code: "STATION_SESSION_LOCKED" });
  }
});
it("accepts the OF without a selected machine, including an existing workshop selection", async () => {
  for (const machine_id of [null, 'machine']) {
    const s = { ...station, machine_id };
    await expect(authorizeCuttingTx(tx([
      [{id: 17}], [{status: 'ACTIVE'}], [{usable: true, user_id: 17, machine_id}],
      [{machine_id: 'operation-machine', material_operation: true}],
    ]), s, 91, 'op')).resolves.toBeUndefined();
  }
});
it("does not let a valid session debit an unprepared operation", async () => {
  const s = { usable: true, user_id: 17, machine_id: "machine" };
  await expect(
    authorizeCuttingTx(
      tx([
        [{ id: 17 }],
        [{ status: "ACTIVE" }],
        [s],
        [{ machine_id: "machine", material_operation: false }],
      ]),
      station,
      91,
      "op",
    ),
  ).rejects.toMatchObject({ code: "STATION_CUTTING_OPERATION_UNKNOWN" });
});
it("refuses a recovering account before reading a device, session or material target", async () => {
  const t = tx([[]]);
  await expect(authorizeCuttingTx(t, station, 91, "op")).rejects.toMatchObject({
    code: "STATION_ACCOUNT_RECOVERY_REQUIRED",
  });
  expect(t.query).toHaveBeenCalledTimes(1);
  expect(t.query).toHaveBeenCalledWith(expect.stringContaining("NOT mfa_reenrollment_required FOR SHARE"), [17]);
});
it("requires an own active pointage consistent with the OF assignment, even without a station machine", async () => {
  const t = tx([]);
  await expect(cuttingPointageTx(t, station, 91, "op")).rejects.toMatchObject({
    code: "STATION_CUTTING_POINTAGE_REQUIRED",
  });
  expect(t.query).toHaveBeenCalledWith(expect.any(String), [
    91,
    "op",
    17,
  ]);
  expect(t.query).toHaveBeenCalledWith(expect.stringContaining('op.machine_id IS NULL OR p.machine_id=op.machine_id'), expect.any(Array));
  expect(
    await cuttingPointageTx(tx([[{ id: "pointage" }]]), {...station, machine_id: null}, 91, "op"),
  ).toBe("pointage");
});
