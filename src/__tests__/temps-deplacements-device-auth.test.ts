import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "../config/app";

describe("borne physique — frontière d’authentification", () => {
  it("atteint l’authentification du terminal sans JWT utilisateur", async () => {
    const response = await request(app).post("/api/v1/time-clock/device-events").send({
      badge_uid: "04AABBCC",
      event_type: "AUTO",
      idempotency_key: "device-test-0001",
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).toContain("HR_DEVICE_UNAUTHORIZED");
  });

  it("conserve les commandes salarié derrière le JWT", async () => {
    const response = await request(app).post("/api/v1/time-clock/events").send({ event_type: "IN" });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain("HR_DEVICE_UNAUTHORIZED");
  });

  it("conserve la configuration et l’administration derrière le JWT", async () => {
    expect((await request(app).get("/api/v1/time-clock/device-config")).status).toBe(401);
    expect((await request(app).get("/api/v1/time-clock/admin/devices")).status).toBe(401);
  });
});
