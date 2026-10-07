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
  const t = tx([[{ status: "REVOKED" }]]);
  await expect(authorizeCuttingTx(t, station, 91, "op")).rejects.toMatchObject({
    code: "STATION_DEVICE_DISABLED",
  });
  expect(t.query).toHaveBeenCalledTimes(1);
});
it("refuses a locked or changed session even for an idempotent transport retry", async () => {
  for (const session of [
    { usable: false, user_id: 17, machine_id: "machine" },
    { usable: true, user_id: 18, machine_id: "machine" },
    { usable: true, user_id: 17, machine_id: "other" },
  ]) {
    await expect(
      authorizeCuttingTx(
        tx([[{ status: "ACTIVE" }], [session]]),
        station,
        91,
        "op",
      ),
    ).rejects.toMatchObject({ code: "STATION_SESSION_LOCKED" });
  }
});
it("does not let a valid session debit another machine or an unprepared operation", async () => {
  const s = { usable: true, user_id: 17, machine_id: "machine" };
  await expect(
    authorizeCuttingTx(
      tx([
        [{ status: "ACTIVE" }],
        [s],
        [{ machine_id: "other", material_operation: true }],
      ]),
      station,
      91,
      "op",
    ),
  ).rejects.toMatchObject({ code: "STATION_CUTTING_MACHINE_CONFLICT" });
  await expect(
    authorizeCuttingTx(
      tx([
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
it("requires a server-resolved active pointage and binds the station operator and machine", async () => {
  const t = tx([]);
  await expect(cuttingPointageTx(t, station, 91, "op")).rejects.toMatchObject({
    code: "STATION_CUTTING_POINTAGE_REQUIRED",
  });
  expect(t.query).toHaveBeenCalledWith(expect.any(String), [
    91,
    "op",
    17,
    "machine",
  ]);
  expect(
    await cuttingPointageTx(tx([[{ id: "pointage" }]]), station, 91, "op"),
  ).toBe("pointage");
});
