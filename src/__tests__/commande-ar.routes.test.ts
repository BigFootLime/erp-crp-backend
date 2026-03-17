import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  generateAr: vi.fn(),
  sendAr: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 7, role: "Secretaire" };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Accès interdit" });
    },
}));

vi.mock("../module/commande-client/services/commande-ar.service", () => ({
  svcGenerateCommandeAr: mocks.generateAr,
  svcSendCommandeAr: mocks.sendAr,
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.generateAr.mockReset();
  mocks.sendAr.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/commandes/:id/ar", () => {
  it("POST /generate returns generated AR draft", async () => {
    mocks.generateAr.mockResolvedValue({
      ar_id: "11111111-1111-1111-1111-111111111111",
      commande_id: 123,
      document_id: "22222222-2222-2222-2222-222222222222",
      document_name: "AR_CC-123.pdf",
      subject: "Accuse de reception CC-123",
      generated_at: "2026-03-12T09:00:00.000Z",
      generated_by: 7,
      status: "GENERATED",
      sent_at: null,
      preview_path: "/commandes/123/documents/22222222-2222-2222-2222-222222222222/file",
      recipient_suggestions: [],
    });

    const res = await request(app)
      .post("/api/v1/commandes/123/ar/generate")
      .set("Authorization", "Bearer fake")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ commande_id: 123, status: "GENERATED" });
    expect(mocks.generateAr).toHaveBeenCalledWith({ commande_id: 123, user_id: 7 });
  });

  it("POST /send returns AR send result", async () => {
    mocks.sendAr.mockResolvedValue({
      ar_id: "11111111-1111-1111-1111-111111111111",
      commande_id: 123,
      document_id: "22222222-2222-2222-2222-222222222222",
      status: "AR_ENVOYEE",
      sent_at: "2026-03-12T09:15:00.000Z",
      recipient_emails: ["client@example.com"],
      email_provider_id: "resend_123",
    });

    const res = await request(app)
      .post("/api/v1/commandes/123/ar/send")
      .set("Authorization", "Bearer fake")
      .send({
        ar_id: "11111111-1111-1111-1111-111111111111",
        recipient_emails: ["client@example.com"],
        recipient_contact_ids: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "AR_ENVOYEE", commande_id: 123 });
    expect(mocks.sendAr).toHaveBeenCalledWith({
      commande_id: 123,
      user_id: 7,
      body: {
        ar_id: "11111111-1111-1111-1111-111111111111",
        recipient_emails: ["client@example.com"],
        recipient_contact_ids: [],
      },
    });
  });
});
