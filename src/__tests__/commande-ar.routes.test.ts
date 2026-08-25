import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { HttpError } from "../utils/httpError";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  generateAr: vi.fn(),
  sendAr: vi.fn(),
  createOfficial: vi.fn(),
  listOfficial: vi.fn(),
  getOfficial: vi.fn(),
  readOfficial: vi.fn(),
  printOfficial: vi.fn(),
  sendOfficial: vi.fn(),
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
  authenticateToken: (
    req: { user?: { id: number; role: string }; headers?: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void
  ) => {
    const requestedRole = req.headers?.["x-test-role"];
    req.user = {
      id: 7,
      role: typeof requestedRole === "string" ? decodeURIComponent(requestedRole) : "Secretaire",
    };
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
  svcCreateCommandeArOfficial: mocks.createOfficial,
  svcListCommandeArOfficialDocuments: mocks.listOfficial,
  svcGetCommandeArOfficialDocument: mocks.getOfficial,
  svcReadCommandeArOfficialDocument: mocks.readOfficial,
  svcRecordCommandeArOfficialPrint: mocks.printOfficial,
  svcSendCommandeArOfficial: mocks.sendOfficial,
}));

// Le gate d'accès module (#326) est monté globalement dans v1.routes.ts. Ce fichier
// ne teste pas le filtrage par module : on le neutralise pour qu'il ne consomme pas
// une réponse de `pool.query` destinée à la route sous test.
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.generateAr.mockReset();
  mocks.sendAr.mockReset();
  mocks.createOfficial.mockReset();
  mocks.listOfficial.mockReset();
  mocks.getOfficial.mockReset();
  mocks.readOfficial.mockReset();
  mocks.printOfficial.mockReset();
  mocks.sendOfficial.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

const OFFICIAL_ID = "33333333-3333-4333-8333-333333333333";
const OFFICIAL_DOCUMENT = {
  id: OFFICIAL_ID,
  kind: "CUSTOMER_ORDER_ACKNOWLEDGEMENT",
  version: 2,
  state: "ISSUED",
  safe_filename: "AR-123-v2.pdf",
  byte_sha256: "a".repeat(64),
  byte_length: 1234,
  mime_type: "application/pdf",
  issued_at: "2026-08-23T10:01:00.000Z",
  source_revision: "2026-08-23 10:00:00+00",
  preview_url: `/commandes/123/acknowledgements/${OFFICIAL_ID}/preview`,
  download_url: `/commandes/123/acknowledgements/${OFFICIAL_ID}/download`,
};
const OFFICIAL_ENVELOPE = {
  state: "READY",
  latest_document: OFFICIAL_DOCUMENT,
  retryable: false,
  failure_code: null,
};

describe("/api/v1/commandes/:id/acknowledgements", () => {
  it("uses the exact safe generation envelope for the collection POST and GET", async () => {
    mocks.listOfficial.mockResolvedValue(OFFICIAL_ENVELOPE);
    mocks.createOfficial.mockResolvedValue({ ...OFFICIAL_ENVELOPE, state: "PENDING" });

    const listed = await request(app)
      .get("/api/v1/commandes/123/acknowledgements")
      .set("Authorization", "Bearer fake");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(OFFICIAL_ENVELOPE);
    expect(mocks.listOfficial).toHaveBeenCalledWith(123);

    const created = await request(app)
      .post("/api/v1/commandes/123/acknowledgements")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "acknowledgement-attempt-001")
      .send({ source_revision: "2026-08-23 10:00:00+00", reissue_reason: "Client requested revised delivery date" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ ...OFFICIAL_ENVELOPE, state: "PENDING" });
    expect(mocks.createOfficial).toHaveBeenCalledWith({
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
      source_revision: "2026-08-23 10:00:00+00",
      reissue_reason: "Client requested revised delivery date",
      idempotency_key: "acknowledgement-attempt-001",
    });
    expect(Object.keys(created.body.latest_document)).toEqual([
      "id", "kind", "version", "state", "safe_filename", "byte_sha256", "byte_length", "mime_type",
      "issued_at", "source_revision", "preview_url", "download_url",
    ]);
  });

  it("requires a per-attempt idempotency key before invoking the generator", async () => {
    const response = await request(app)
      .post("/api/v1/commandes/123/acknowledgements")
      .set("Authorization", "Bearer fake")
      .send({ source_revision: "2026-08-23 10:00:00+00" });
    expect(response.status).toBe(400);
    expect(mocks.createOfficial).not.toHaveBeenCalled();
  });

  it("keeps detail, exact-byte delivery, print intent, and send scoped to the parent order", async () => {
    mocks.getOfficial.mockResolvedValue(OFFICIAL_DOCUMENT);
    mocks.readOfficial.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7 official"), filename: OFFICIAL_DOCUMENT.safe_filename, sha256: OFFICIAL_DOCUMENT.byte_sha256 });
    mocks.printOfficial.mockResolvedValue(undefined);
    mocks.sendOfficial.mockResolvedValue({ commande_id: 123, status: "AR_ENVOYE" });

    const detail = await request(app)
      .get(`/api/v1/commandes/123/acknowledgements/${OFFICIAL_ID}`)
      .set("Authorization", "Bearer fake");
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(OFFICIAL_DOCUMENT);

    const preview = await request(app)
      .get(`/api/v1/commandes/123/acknowledgements/${OFFICIAL_ID}/preview`)
      .set("Authorization", "Bearer fake");
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");

    const download = await request(app)
      .get(`/api/v1/commandes/123/acknowledgements/${OFFICIAL_ID}/download`)
      .set("Authorization", "Bearer fake");
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");

    const printed = await request(app)
      .post(`/api/v1/commandes/123/acknowledgements/${OFFICIAL_ID}/print-intents`)
      .set("Authorization", "Bearer fake");
    expect(printed.status).toBe(204);

    const sent = await request(app)
      .post(`/api/v1/commandes/123/acknowledgements/${OFFICIAL_ID}/send`)
      .set("Authorization", "Bearer fake")
      .send({ recipient_emails: ["client@example.test"], recipient_contact_ids: [] });
    expect(sent.status).toBe(200);
    expect(mocks.getOfficial).toHaveBeenCalledWith(123, OFFICIAL_ID);
    expect(mocks.readOfficial).toHaveBeenNthCalledWith(1, 123, OFFICIAL_ID, 7, "AUTHORITATIVE_PDF_PREVIEWED");
    expect(mocks.readOfficial).toHaveBeenNthCalledWith(2, 123, OFFICIAL_ID, 7, "AUTHORITATIVE_PDF_DOWNLOADED");
    expect(mocks.printOfficial).toHaveBeenCalledWith(123, OFFICIAL_ID, 7);
    expect(mocks.sendOfficial).toHaveBeenCalledWith({
      commande_id: 123,
      archive_id: OFFICIAL_ID,
      user_id: 7,
      user_role: "Secretaire",
      body: { recipient_emails: ["client@example.test"], recipient_contact_ids: [] },
    });
  });

  it("default-denies acknowledgement export for a role without the explicit capability", async () => {
    const response = await request(app)
      .get("/api/v1/commandes/123/acknowledgements")
      .set("Authorization", "Bearer fake")
      .set("x-test-role", "Employee");
    expect(response.status).toBe(403);
    expect(mocks.listOfficial).not.toHaveBeenCalled();
  });
});

describe("/api/v1/commandes/:id/ar", () => {
  it.each(["Employee", "Directeur Technique", "Responsable Qualité"])(
    "delegates AR authorization for the exact identity %s to the checkpoint policy",
    async (role) => {
      const forbidden = new HttpError(403, "COMMAND_CHECKPOINT_FORBIDDEN", "forbidden");
      mocks.generateAr.mockRejectedValueOnce(forbidden);
      mocks.sendAr.mockRejectedValueOnce(forbidden);
      const generate = await request(app)
        .post("/api/v1/commandes/123/ar/generate")
        .set("Authorization", "Bearer fake")
        .set("x-test-role", encodeURIComponent(role))
        .send({});

      const send = await request(app)
        .post("/api/v1/commandes/123/ar/send")
        .set("Authorization", "Bearer fake")
        .set("x-test-role", encodeURIComponent(role))
        .send({
          ar_id: "11111111-1111-1111-1111-111111111111",
          recipient_emails: ["client@example.com"],
          recipient_contact_ids: [],
        });

      expect(generate.status).toBe(403);
      expect(send.status).toBe(403);
      expect(mocks.generateAr).toHaveBeenCalledWith({ commande_id: 123, user_id: 7, user_role: role });
      expect(mocks.sendAr).toHaveBeenCalledWith(expect.objectContaining({ user_id: 7, user_role: role }));
    }
  );

  it("accepts an authorized role from the central multi-role representation", async () => {
    mocks.generateAr.mockResolvedValue({ commande_id: 123, status: "GENERATED" });

    const res = await request(app)
      .post("/api/v1/commandes/123/ar/generate")
      .set("Authorization", "Bearer fake")
      .set("x-test-role", "Employee | Secretaire")
      .send({});

    expect(res.status).toBe(201);
    expect(mocks.generateAr).toHaveBeenCalledWith({ commande_id: 123, user_id: 7, user_role: "Employee | Secretaire" });
  });

  it("POST /generate returns generated AR draft", async () => {
    mocks.generateAr.mockResolvedValue({
      ar_id: "11111111-1111-1111-1111-111111111111",
      commande_id: 123,
      document_id: "22222222-2222-2222-2222-222222222222",
      document_name: "AR_CC-123.pdf",
      subject: "Accuse de reception CC-123",
      default_message: "Bonjour Client,\n\nVeuillez trouver ci-joint votre accusé de réception.",
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
    expect(res.body).toMatchObject({
      commande_id: 123,
      status: "GENERATED",
      default_message: expect.stringContaining("Veuillez trouver ci-joint"),
    });
    expect(mocks.generateAr).toHaveBeenCalledWith({ commande_id: 123, user_id: 7, user_role: "Secretaire" });
  });

  it("POST /send returns AR send result", async () => {
    mocks.sendAr.mockResolvedValue({
      ar_id: "11111111-1111-1111-1111-111111111111",
      commande_id: 123,
      document_id: "22222222-2222-2222-2222-222222222222",
      status: "AR_ENVOYE",
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
        email_body: "Bonjour Client,\n\nVeuillez trouver ci-joint votre accusé de réception.",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "AR_ENVOYE", commande_id: 123 });
    expect(mocks.sendAr).toHaveBeenCalledWith({
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
      body: {
        ar_id: "11111111-1111-1111-1111-111111111111",
        recipient_emails: ["client@example.com"],
        recipient_contact_ids: [],
        email_body: "Bonjour Client,\n\nVeuillez trouver ci-joint votre accusé de réception.",
      },
    });
  });
});
