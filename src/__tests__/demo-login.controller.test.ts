import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  loginUser: vi.fn(async () => ({ token: "visitor-token", user: { username: "DEMO" } })),
}));

vi.mock("../module/auth/services/auth.service", () => ({
  loginUser: service.loginUser,
}));

import { demoLogin } from "../module/auth/controllers/auth.controller";

const original = {
  demoMode: process.env.CERP_DEMO_MODE,
  username: process.env.DEMO_SEED_USERNAME,
  password: process.env.DEMO_SEED_PASSWORD,
};

function restore(name: keyof typeof original) {
  const value = original[name];
  const envName = name === "demoMode" ? "CERP_DEMO_MODE" : name === "username" ? "DEMO_SEED_USERNAME" : "DEMO_SEED_PASSWORD";
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.post("/auth/demo/login", demoLogin);
  instance.use((error: { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ code: error.code ?? "INTERNAL" });
  });
  return instance;
}

describe("CERP-DEMO-01 visitor login", () => {
  afterEach(() => {
    restore("demoMode");
    restore("username");
    restore("password");
    service.loginUser.mockClear();
  });

  it("uses a fixed separate quality reviewer through the normal login service",async()=>{
    process.env.CERP_DEMO_MODE="true";
    process.env.DEMO_SEED_USERNAME="DEMO";
    process.env.DEMO_SEED_PASSWORD="test-visitor-password";
    await request(app()).post("/auth/demo/login").set("X-CERP-Database","cerp_demo").send({persona:"quality-reviewer",username:"ADMIN"}).expect(200);
    expect(service.loginUser).toHaveBeenCalledWith("DEMO_QUALITE","test-visitor-password",expect.anything());
  });

  it("does not exist outside demo mode", async () => {
    process.env.CERP_DEMO_MODE = "false";
    await request(app()).post("/auth/demo/login").expect(404);
    expect(service.loginUser).not.toHaveBeenCalled();
  });

  it("uses only server-side credentials and returns the native login response", async () => {
    process.env.CERP_DEMO_MODE = "true";
    process.env.DEMO_SEED_USERNAME = "DEMO";
    process.env.DEMO_SEED_PASSWORD = "test-visitor-password";

    const response = await request(app())
      .post("/auth/demo/login")
      .set("X-CERP-Database", "cerp_demo")
      .send({ username: "ignored", password: "ignored" })
      .expect(200);

    expect(response.body).toEqual({
      message: "Connexion réussie",
      token: "visitor-token",
      user: { username: "DEMO" },
    });
    expect(service.loginUser).toHaveBeenCalledWith(
      "DEMO",
      "test-visitor-password",
      expect.objectContaining({ ip: expect.anything() }),
    );
  });
});
