import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const fixture = vi.hoisted(() => ({
  measurements: [] as Array<Record<string, unknown>>,
  query: vi.fn(),
  history: vi.fn(),
  receipt: vi.fn(),
  event: vi.fn(),
  replay: false,
  status: "IN_PROGRESS",
}));

vi.mock("../module/metrologie/repository/metrology-shared.repository", () => ({
  db: () => ({ query: fixture.query }),
  withTransaction: (fn: (client: PoolClient) => unknown) => fn({ query: fixture.query } as unknown as PoolClient),
  acquireIdempotency: async () => ({ replay: fixture.replay, idempotencyKey: "recipe-1073" }),
  insertMetrologyEvent: fixture.event,
  insertAuditLog: vi.fn(),
  saveReceipt: fixture.receipt,
  isRecord: (value: unknown) => value !== null && typeof value === "object",
  toInt: (value: unknown, fallback = 0) => value == null ? fallback : Number(value),
  toNumber: (value: unknown) => value == null ? null : Number(value),
  sortDirection: () => "ASC",
  rethrowMapped: (error: unknown) => { throw error; },
}));
vi.mock("../module/metrologie/repository/metrology-registry.repository", () => ({
  monthsFromPeriodicity: vi.fn(), syncLegacyPlan: vi.fn(),
}));
vi.mock("../module/metrologie/repository/metrology-impact.repository", () => ({ openImpactDossier: vi.fn() }));
vi.mock("../shared/codes/code-generator.service", () => ({ generateMetrologieExecutionCode: vi.fn() }));
vi.mock("../shared/uploads/secure-upload", () => ({ transferSecureUploadToDestination: vi.fn() }));
vi.mock("../shared/uploads/upload-transaction", () => ({ withUploadTransaction: vi.fn() }));
vi.mock("../utils/cerpStorage", () => ({ ensureDocumentStoragePath: vi.fn() }));

import { repoRecordMeasurements } from "../module/metrologie/repository/metrology-execution.repository";
import type { MetrologyActor } from "../module/metrologie/repository/metrology-shared.repository";
import type { MeasurementInputDTO } from "../module/metrologie/validators/metrology-360.validators";

const executionId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-10-10T00:00:00.000Z";
const actor: MetrologyActor = {
  user_id: 1, role: "administrateur", ip: null, user_agent: null, device_type: null,
  os: null, browser: null, path: null, page_key: null, client_session_id: null, request_id: null,
};
const point = (nominal: number, revision_reason: string | null = null): MeasurementInputDTO => ({
  point_key: `P${nominal}`, sample_no: 1, label: null, nominal,
  tolerance_min: nominal - 0.03, tolerance_max: nominal + 0.03, measured: nominal,
  unite: "mm", incertitude: null, comment: "Synthetic recipe", revision_reason,
});
const record = (measurements: MeasurementInputDTO[]) => repoRecordMeasurements({
  executionId, actor, idempotencyKey: "recipe-1073",
  body: { expected_updated_at: timestamp, measurements },
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.measurements = [];
  fixture.status = "IN_PROGRESS";
  fixture.replay = false;
  fixture.query.mockImplementation(async (raw: string, values: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (sql.includes("FROM public.metrologie_execution") && !sql.includes("measurement")) {
      return { rows: [{ id: executionId, code: "MEX-RECIPE", equipement_id: executionId,
        operation_type: "ETALONNAGE", status: fixture.status, updated_at: timestamp,
        started_at: timestamp, plan_version_id: executionId, created_at: timestamp }] };
    }
    if (sql.includes("FROM public.metrologie_plan_version")) {
      return { rows: [{ id: executionId, version: 1, status: "ACTIVE", operation_type: "ETALONNAGE",
        tolerance_min: "-0.03", tolerance_max: "0.03", unite: "mm", criteres: { min_points: 3 } }] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM public.metrologie_execution_measurement")) {
      return { rows: values.length === 3 ? fixture.measurements.filter(row => row.point_key === values[1]) : fixture.measurements };
    }
    if (sql.startsWith("INSERT INTO public.metrologie_measurement_revision")) {
      fixture.history(values);
    }
    if (sql.startsWith("INSERT INTO public.metrologie_execution_measurement")) {
      const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map(column => column.trim());
      const placeholders = sql.slice(sql.indexOf("VALUES (") + 8, sql.lastIndexOf(")")).split(",");
      const row: Record<string, unknown> = { id: `measurement-${fixture.measurements.length}`, revision: 1 };
      columns.forEach((column, index) => { row[column] = values[Number(placeholders[index].match(/\$(\d+)/)?.[1]) - 1]; });
      fixture.measurements.push(row);
    }
    if (sql.startsWith("UPDATE public.metrologie_execution_measurement")) {
      // Canonical #229 trigger contract: every UPDATE must increment revision.
      if (!sql.includes("revision = revision + 1")) {
        throw Object.assign(new Error("a metrology measurement correction must increment its revision"), { code: "P0001" });
      }
      const row = fixture.measurements.find(row => row.id === values[0]);
      if (!row) throw new Error("Unknown measurement");
      for (const [, column, parameter] of sql.matchAll(/([a-z_]+) = \$(\d+)/g)) row[column] = values[Number(parameter) - 1];
      row.revision = Number(row.revision) + 1;
    }
    return { rows: [] };
  });
});

describe("#1073 measurement writes under the canonical revision guard", () => {
  it("stores initial measurements with their computed verdict and deviation", async () => {
    const result = await record([point(0), point(50), point(100)]);
    expect(result.measurements).toHaveLength(3);
    expect(result.measurements.map(row => [row.measured, row.verdict, row.ecart, row.revision]))
      .toEqual([[0, "CONFORME", 0, 1], [50, "CONFORME", 0, 1], [100, "CONFORME", 0, 1]]);
    expect(fixture.history).not.toHaveBeenCalled();
    expect(fixture.event).toHaveBeenCalledOnce();
    expect(fixture.receipt).toHaveBeenCalledOnce();
  });

  it("revises the value and verdict together while preserving the previous values and reason", async () => {
    fixture.measurements.push({ ...point(50), id: "measurement-existing", revision: 1, verdict: "CONFORME", ecart: 0 });
    const measurement = { ...point(50, "Fictive reading corrected after transcription"), measured: 50.04 };
    const result = await record([measurement]);
    expect(result.measurements[0]).toMatchObject({ measured: 50.04, verdict: "NON_CONFORME", ecart: 0.04, revision: 2 });
    expect(fixture.history).toHaveBeenCalledOnce();
    const values = fixture.history.mock.calls[0][0];
    expect(JSON.parse(values[2])).toMatchObject({ measured: 50 });
    expect(values[3]).toBe(measurement.revision_reason);
  });

  it("refuses a correction without a reason", async () => {
    fixture.measurements.push({ ...point(50), id: "existing", revision: 1 });
    await expect(record([point(50)])).rejects.toMatchObject({ code: "METROLOGY_MEASUREMENT_REVISION_REASON_REQUIRED" });
    expect(fixture.history).not.toHaveBeenCalled();
    expect(fixture.receipt).not.toHaveBeenCalled();
  });

  it("does not edit measurements of a validated execution", async () => {
    fixture.status = "VALIDATED";
    await expect(record([point(0)])).rejects.toThrow();
    expect(fixture.measurements).toEqual([]);
    expect(fixture.receipt).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay without another write or event", async () => {
    fixture.replay = true;
    await record([point(0)]);
    expect(fixture.measurements).toEqual([]);
    expect(fixture.event).not.toHaveBeenCalled();
    expect(fixture.receipt).not.toHaveBeenCalled();
  });
});
