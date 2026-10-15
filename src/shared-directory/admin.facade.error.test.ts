import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./site-runtime", () => ({
  sharedDirectoryClient: () => mocks.client,
  projectDirectoryProfile: vi.fn(),
}));

import { errorHandler } from "../middlewares/errorHandler";
import { DirectoryClient, LOCAL_DIRECTORY_ENDPOINT } from "./client";
import { directoryAdminCall } from "./admin.facade";

function app() {
  const server = express();
  server.use((req, _res, next) => { req.user = { id: 1, directory_session: "dir_" + "a".repeat(64) } as never; next(); });
  server.post("/mutation", async (req, res, next) => {
    try { res.json(await directoryAdminCall({} as never, req, "admin-user-superadmin", {})); } catch (error) { next(error); }
  });
  server.use(errorHandler);
  return server;
}

describe("directory administrative transport errors", () => {
  afterEach(() => { vi.unstubAllGlobals(); mocks.client = null; });

  it("maps a real DirectoryClient stale-membership response through the facade and normal error handler", async () => {
    mocks.client = new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT, "cerp_test", "a".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "DIRECTORY_MEMBERSHIP_STALE", message: "internal source text" }) }));

    const response = await request(app()).post("/mutation").expect(409);
    expect(response.body).toMatchObject({ code: "DIRECTORY_MEMBERSHIP_STALE", message: "Les droits de ce compte viennent de changer ; actualisez avant de réessayer." });
  });

  it("preserves directory unavailability as a 503", async () => {
    mocks.client = new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT, "cerp_test", "a".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("transport down")));

    const response = await request(app()).post("/mutation").expect(503);
    expect(response.body).toMatchObject({ code: "DIRECTORY_UNAVAILABLE" });
  });

  it("requests the normal MFA confirmation when freshness expires while waiting for an authority lock", async () => {
    mocks.client = new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT, "cerp_test", "a".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: "MFA_STEP_UP_REQUIRED", message: "private authority text" }) }));

    const response = await request(app()).post("/mutation").expect(428);
    expect(response.body).toMatchObject({ code: "MFA_STEP_UP_REQUIRED", message: "Confirmez votre double authentification pour cette opération." });
  });

  it("does not trust an unlisted remote error code", async () => {
    mocks.client = new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT, "cerp_test", "a".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "UNLISTED_REMOTE_CODE", message: "untrusted" }) }));

    const response = await request(app()).post("/mutation").expect(500);
    expect(response.body).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
