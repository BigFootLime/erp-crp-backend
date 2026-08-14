import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ getLive: vi.fn() }));
vi.mock("../repository/client-portal.repository", () => ({
  repoGetLivePortalAccount: mocked.getLive,
}));

import { signPortalSession } from "../domain/client-portal-security";
import { authenticateClientPortal } from "./client-portal-auth.middleware";

const previousPortalSecret = process.env.CLIENT_PORTAL_JWT_SECRET;

function responseDouble() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe("authenticateClientPortal", () => {
  beforeEach(() => {
    process.env.CLIENT_PORTAL_JWT_SECRET = "sol29-test-secret-with-at-least-32-characters";
    mocked.getLive.mockReset();
  });

  afterEach(() => {
    if (previousPortalSecret === undefined) delete process.env.CLIENT_PORTAL_JWT_SECRET;
    else process.env.CLIENT_PORTAL_JWT_SECRET = previousPortalSecret;
  });

  it("rejects an ERP JWT even when it is structurally valid", () => {
    const erpToken = jwt.sign({ id: 1, role: "Directeur" }, "erp-secret");
    const req = { headers: { authorization: `Bearer ${erpToken}` }, originalUrl: "/api/v1/portal/orders" } as Request;
    const { response, status } = responseDouble();
    authenticateClientPortal(req, response, vi.fn() as NextFunction);
    expect(status).toHaveBeenCalledWith(401);
    expect(mocked.getLive).not.toHaveBeenCalled();
  });

  it("revalidates the live account status and epoch before every request", async () => {
    const identity = {
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      clientId: "042",
      sessionEpoch: 3,
    };
    const token = signPortalSession(identity);
    mocked.getLive.mockResolvedValue({ ...identity, id: identity.accountId, client_id: identity.clientId, status: "ACTIVE", session_epoch: 3 });
    const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: "/api/v1/portal/orders" } as Request;
    const { response } = responseDouble();
    const next = vi.fn();
    authenticateClientPortal(req, response, next as NextFunction);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(req.portalIdentity).toEqual(identity);
  });

  it("revokes a token immediately after a session epoch change", async () => {
    const identity = {
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      clientId: "042",
      sessionEpoch: 3,
    };
    const token = signPortalSession(identity);
    mocked.getLive.mockResolvedValue({ id: identity.accountId, client_id: identity.clientId, status: "ACTIVE", session_epoch: 4 });
    const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: "/api/v1/portal/orders" } as Request;
    const { response, status } = responseDouble();
    authenticateClientPortal(req, response, vi.fn() as NextFunction);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(401));
  });
});

