import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";
import openApiRoutes from "../swagger/openapi.routes";

describe("SOL-28 public OpenAPI route", () => {
  it("serves the deployed contract with immutable provenance and no secret-bearing cache", async () => {
    const app = express().use("/api/v1", openApiRoutes);
    const response = await request(app).get("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(response.body.openapi).toBe("3.0.3");
    expect(response.body["x-cerp-route-coverage"]).toMatchObject({
      discovered: GENERATED_ROUTE_INVENTORY.length,
      documented: GENERATED_ROUTE_INVENTORY.length,
      percent: 100,
    });
  });
});
