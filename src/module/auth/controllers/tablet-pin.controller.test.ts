import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const directory = vi.hoisted(() => ({
  available: true,
  call: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: {} }));
vi.mock("../../../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => directory.available ? { call: directory.call } : null,
  directoryAuthenticationResult: directory.authenticate,
}));

import { errorHandler } from "../../../middlewares/errorHandler";
import { validationErrorMiddleware } from "../middlewares/validationError.middleware";
import {
  tabletPinAdminList,
  tabletPinAdminRevoke,
  tabletPinLogin,
  tabletPinPair,
  tabletPinSet,
  tabletPinStatus,
} from "./auth.controller";

const deviceId = "00000000-0000-4000-8000-000000000010";
const deviceSecret = "a".repeat(64);
const pairingCode = "b".repeat(32);

function app(withDirectorySession = true) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      id: 1,
      username: "operator",
      email: "operator@example.test",
      role: "Operateur",
      directory_session: "dir_" + "a".repeat(64),
    };
    if (!withDirectorySession) delete req.user.directory_session;
    next();
  });
  instance.post("/tablet-pin/pair", tabletPinPair);
  instance.post("/tablet-pin/login", tabletPinLogin);
  instance.put("/me/tablet-pin", tabletPinSet);
  instance.get("/me/tablet-pin", tabletPinStatus);
  instance.get("/tablet-pin/devices", tabletPinAdminList);
  instance.delete("/tablet-pin/devices/:deviceId", tabletPinAdminRevoke);
  instance.use(validationErrorMiddleware);
  instance.use(errorHandler);
  return instance;
}

function directoryFailure(status: number, code: string, message = "directory secret text") {
  return Object.assign(new Error(message), { status, code });
}

describe("tablet PIN public HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    directory.available = true;
  });

  it("reports an unavailable PIN feature without rejecting a valid local password session", async () => {
    directory.available = false;
    const response = await request(app(false)).get("/me/tablet-pin").expect(200);
    expect(response.body).toEqual({ available: false, configured: false });
    expect(directory.call).not.toHaveBeenCalled();
  });

  it("rejects PIN writes as unavailable rather than expiring a local password session", async () => {
    directory.available = false;
    const response = await request(app(false)).put("/me/tablet-pin").send({ pin: "0123" }).expect(503);
    expect(response.body.code).toBe("DIRECTORY_UNAVAILABLE");
    expect(directory.call).not.toHaveBeenCalled();
  });

  it("still requires a Directory session when the authority is configured", async () => {
    const response = await request(app(false)).get("/me/tablet-pin").expect(401);
    expect(response.body.code).toBe("DIRECTORY_SESSION_REQUIRED");
    expect(directory.call).not.toHaveBeenCalled();
  });

  it("keeps a PIN status dependency failure retryable", async () => {
    directory.call.mockRejectedValueOnce(new Error("fixture authority timeout"));
    const response = await request(app()).get("/me/tablet-pin").expect(503);
    expect(response.body.code).toBe("DIRECTORY_UNAVAILABLE");
  });

  it("rejects malformed bodies before calling the Directory", async () => {
    const response = await request(app())
      .post("/tablet-pin/pair")
      .send({ pairingCode: "not-a-pairing-code" })
      .expect(400);

    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(directory.call).not.toHaveBeenCalled();
  });

  it("rejects malformed administrative device identifiers before calling the Directory", async () => {
    const response = await request(app())
      .delete("/tablet-pin/devices/not-a-uuid")
      .expect(400);

    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(directory.call).not.toHaveBeenCalled();
  });

  it("maps PIN-only camelCase input to the Directory wire format without a username", async () => {
    directory.call.mockResolvedValueOnce({ directory_session: "directory-session", identity: { profile_id: "profile" } });
    directory.authenticate.mockResolvedValueOnce({ token: "site-token", user: { id: 1 } });

    const response = await request(app())
      .post("/tablet-pin/login")
      .send({ pin: "0123", deviceId, deviceSecret })
      .expect(200);

    expect(directory.call).toHaveBeenCalledWith("tablet-pin-login", expect.objectContaining({
      input: { pin: "0123", device_id: deviceId, device_secret: deviceSecret },
    }));
    expect(response.body).toEqual({ message: "Connexion réussie", token: "site-token", user: { id: 1 } });
  });

  it("retains username only as a legacy-client compatibility field", async () => {
    directory.call.mockResolvedValueOnce({ directory_session: "directory-session", identity: { profile_id: "profile" } });
    directory.authenticate.mockResolvedValueOnce({ token: "site-token", user: { id: 1 } });
    await request(app()).post("/tablet-pin/login").send({ username: "operator", pin: "0123", deviceId, deviceSecret }).expect(200);
    expect(directory.call).toHaveBeenCalledWith("tablet-pin-login", expect.objectContaining({
      input: { username: "OPERATOR", pin: "0123", device_id: deviceId, device_secret: deviceSecret },
    }));
  });

  it("returns 204 for a successful personal PIN mutation", async () => {
    directory.call.mockResolvedValueOnce({ ok: true });

    const response = await request(app())
      .put("/me/tablet-pin")
      .send({ pin: "0123" })
      .expect(204);

    expect(response.text).toBe("");
    expect(directory.call).toHaveBeenCalledWith("tablet-pin-set", expect.objectContaining({ input: { pin: "0123" } }));
  });

  it.each([
    ["a missing tablet", "delete", 404, "TABLET_DEVICE_NOT_FOUND", 404, "TABLET_DEVICE_NOT_FOUND", "Tablette introuvable."],
    ["a forbidden admin list", "list", 403, "DIRECTORY_ADMIN_REQUIRED", 403, "DIRECTORY_ADMIN_REQUIRED", "Droits administrateur requis."],
    ["a rejected Directory session", "list", 401, "DIRECTORY_SESSION_REJECTED", 401, "DIRECTORY_SESSION_REJECTED", "Une nouvelle connexion est requise."],
    ["a trusted limiter response", "list", 429, "TOO_MANY_ATTEMPTS", 429, "TOO_MANY_ATTEMPTS", "Trop de tentatives. Réessayez plus tard."],
  ])("translates %s without exposing the Directory message", async (_caseName, target, upstreamStatus, upstreamCode, expectedStatus, expectedCode, expectedMessage) => {
    directory.call.mockRejectedValueOnce(directoryFailure(upstreamStatus, upstreamCode));
    const response = target === "delete"
      ? await request(app()).delete(`/tablet-pin/devices/${deviceId}`).expect(expectedStatus)
      : await request(app()).get("/tablet-pin/devices").expect(expectedStatus);

    expect(response.body).toEqual({
      success: false,
      code: expectedCode,
      message: expectedMessage,
      path: target === "delete" ? `/tablet-pin/devices/${deviceId}` : "/tablet-pin/devices",
    });
    expect(JSON.stringify(response.body)).not.toContain("directory secret text");
  });

  it.each([
    [418, "UPSTREAM_PRIVATE_FAILURE"],
    [429, "UPSTREAM_PRIVATE_FAILURE"],
  ])("turns unsafe Directory failure %i:%s into a non-leaking 503", async (status, code) => {
    directory.call.mockRejectedValueOnce(directoryFailure(status, code, "private upstream secret"));

    const response = await request(app()).get("/tablet-pin/devices").expect(503);

    expect(response.body).toEqual({
      success: false,
      code: "DIRECTORY_UNAVAILABLE",
      message: "Erreur serveur.",
      path: "/tablet-pin/devices",
    });
    expect(JSON.stringify(response.body)).not.toContain("private upstream secret");
  });
});
