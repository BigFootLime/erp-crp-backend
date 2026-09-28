import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createObservabilityRouter } from "../shared/observability/routes";

describe("CERP-DEMO-01 readiness", () => {
  const previous = process.env.CERP_DEMO_MODE;

  afterEach(() => {
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  function healthApp(query: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(createObservabilityRouter({ query } as unknown as Pool));
    return app;
  }

  it("returns 200 when the isolated demo database is reachable", async () => {
    process.env.CERP_DEMO_MODE = "true";
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const response = await request(healthApp(query)).get("/health/ready").expect(200);
    expect(response.body.status).toBe("ready");
    expect(response.body.checks.database).toMatchObject({ status: "up", required: true });
    expect(response.body.checks.realtime).toMatchObject({ required: false, disabled: true, reason_code: "DEMO_DISABLED" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the isolated demo database is unavailable", async () => {
    process.env.CERP_DEMO_MODE = "true";
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" }));
    const response = await request(healthApp(query)).get("/health/ready").expect(503);
    expect(response.body.checks.database).toMatchObject({ status: "down", required: true, reason_code: "ECONNREFUSED" });
  });
});
