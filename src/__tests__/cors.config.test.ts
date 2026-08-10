import { describe, expect, it } from "vitest";
import request from "supertest";

import app from "../config/app";

describe("CORS configuration", () => {
  it("accepts the production UI correlation headers during login preflight", async () => {
    const res = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "https://cerp.croix-rousse-precision.fr")
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "content-type,x-cerp-database,x-request-id,x-correlation-id"
      );

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://cerp.croix-rousse-precision.fr"
    );
    expect(res.headers["access-control-allow-headers"]).toContain("X-Request-Id");
    expect(res.headers["access-control-allow-headers"]).toContain("X-Correlation-Id");
    expect(res.headers["access-control-expose-headers"]).toContain("X-Correlation-Id");
  });

  it("allows the frontend database header during login preflight", async () => {
    const res = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-cerp-database");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-headers"]).toContain("X-CERP-Database");
  });

  it("allows the packaged desktop origin when requests bypass the Electron proxy", async () => {
    const res = await request(app)
      .options("/api/v1/auth/login")
      .set("Origin", "app://cerp")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-cerp-database");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("app://cerp");
  });
});
