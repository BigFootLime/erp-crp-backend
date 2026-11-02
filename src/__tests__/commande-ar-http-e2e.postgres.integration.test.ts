import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.CERP_AR_HTTP_E2E_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

let db: Pool;
let app: import("express").Express;
let emailSink: Server;
let emailSinkUrl: string;
let storageRoot: string;
let mfa: { mfa_factor_id: string; mfa_factor_version: number };
let secretary: { id: number; username: string; email: string };
let receivedEmails: Array<{
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}> = [];

function requireIsolatedDatabase(): void {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error(
      "CERP_AR_HTTP_E2E_DATABASE_URL must exactly match DATABASE_URL",
    );
  }
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(target.hostname) ||
    target.port !== "56145" ||
    target.pathname !== "/cerp_test"
  ) {
    throw new Error("AR HTTP E2E only runs on loopback:56145/cerp_test");
  }
  if (process.env.CERP_AR_HTTP_E2E !== "1")
    throw new Error("Explicit CERP_AR_HTTP_E2E=1 opt-in required");
}

function authToken(): string {
  return jwt.sign(
    {
      id: secretary.id,
      username: secretary.username,
      email: secretary.email,
      role: "Secretaire",
      mfa: true,
      amr: ["totp"],
      mfa_verified_at: Math.floor(Date.now() / 1000),
      mfa_factor_id: mfa.mfa_factor_id,
      mfa_factor_version: mfa.mfa_factor_version,
    },
    process.env.JWT_SECRET!,
    { expiresIn: "5m" },
  );
}

async function seedOrdinarySecretary(): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin,mfa_required)
    VALUES($1,'DISABLED_E2E_CREDENTIAL','Secrétaire','Recette',$2,'Secretaire','Active',false,true) RETURNING id`,
    [
      `ar-e2e-secretary-${suffix}`,
      `ar-e2e-secretary-${suffix}@invalid.example`,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("Unable to create the isolated Secretary fixture");
  secretary = {
    id,
    username: `ar-e2e-secretary-${suffix}`,
    email: `ar-e2e-secretary-${suffix}@invalid.example`,
  };
  await db.query(
    "INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by) VALUES($1,'Secretaire',NULL)",
    [id],
  );
  const factor = await db.query<{ id: string; version: number }>(
    `INSERT INTO public.user_mfa_factors(user_id,factor_type,state,encrypted_secret,encryption_iv,encryption_tag,key_id,version,enrolled_at)
    VALUES($1,'TOTP','ACTIVE',decode(repeat('00',16),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'e2e-local',1,now()) RETURNING id::text,version`,
    [id],
  );
  if (!factor.rows[0])
    throw new Error("Unable to create the isolated Secretary MFA fixture");
  mfa = {
    mfa_factor_id: factor.rows[0].id,
    mfa_factor_version: factor.rows[0].version,
  };
  await db.query(
    `INSERT INTO public.app_module_user_access(user_id,module_key,access,updated_by)
    VALUES($1,'commandes-clients','GRANTED',NULL)`,
    [id],
  );
}

async function repairAbandonedSecretaryFixtures(): Promise<void> {
  // A prior interrupted local test may have written the fixture account before
  // its role assignment. Repair only this test's unique prefix; deletion is
  // unsafe because retained audit records can refer to an account.
  await db.query(`INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by)
    SELECT id,'Secretaire',NULL FROM public.users WHERE username LIKE 'ar-e2e-secretary-%'
    ON CONFLICT (user_id,role_key) DO NOTHING`);
}

async function seedReadyOrder(
  tag: string,
): Promise<{ orderId: number; eventId: string }> {
  const shortTag = tag.replace(/-/g, "").slice(0, 12);
  const order = await db.query<{ id: string }>(
    `INSERT INTO public.commande_client(numero, code_client, date_commande, total_ht, total_ttc, order_type)
    VALUES($1,$2,CURRENT_DATE,10,12,'FERME') RETURNING id::text AS id`,
    [`AR-E2E-${shortTag}`, `CLIENT-${shortTag}`],
  );
  const orderId = Number(order.rows[0]!.id);
  await db.query(
    "INSERT INTO public.commande_historique(commande_id,nouveau_statut) VALUES($1,'PLANNING_VALIDE')",
    [orderId],
  );
  await db.query(
    `INSERT INTO public.commande_client_workflow_checkpoint(commande_id,checkpoint_code,label,sort_order,status,responsible_role)
    VALUES($1,'ar_preparation','Préparation AR',1,'active','secretariat')`,
    [orderId],
  );
  await db.query(
    `INSERT INTO public.commande_client_workflow_checkpoint(commande_id,checkpoint_code,label,sort_order,status,responsible_role)
    VALUES($1,'ar_sent','Envoi AR',2,'pending','secretariat')`,
    [orderId],
  );
  const line = await db.query<{ id: string }>(
    `INSERT INTO public.commande_ligne(commande_id,designation,quantite,unite,prix_unitaire_ht)
    VALUES($1,'Ligne E2E AR',5,'u',2) RETURNING id::text AS id`,
    [orderId],
  );
  const piece = await db.query<{
    id: string;
    version_id: string;
  }>(`SELECT p.id::text AS id,v.id::text AS version_id
    FROM public.pieces_techniques p JOIN public.piece_technique_versions v ON v.piece_technique_id=p.id
    ORDER BY p.id,v.created_at DESC LIMIT 1`);
  const machine = await db.query<{ id: string }>(
    "SELECT id::text AS id FROM public.machines ORDER BY id LIMIT 1",
  );
  if (!piece.rows[0] || !machine.rows[0])
    throw new Error("E2E fixture requires a technical piece and machine");
  const snapshot = '{"operations":[{"phase":10}]}' as const;
  const snapshotSha = "a".repeat(64);
  const tx = await db.connect();
  let ofId: string;
  try {
    await tx.query("BEGIN");
    const of = await tx.query<{ id: string }>(
      `INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,commande_id,commande_ligne_id,statut,technical_readiness,technical_snapshot_sha256,technical_snapshot,technical_snapshot_at,quantite_lancee)
      VALUES($1,$2::uuid,$3::uuid,$4,$5,'PLANIFIE','VALIDATED',$6,$7::jsonb,now(),5) RETURNING id::text AS id`,
      [
        `OF-AR-E2E-${shortTag}`,
        piece.rows[0].id,
        piece.rows[0].version_id,
        orderId,
        line.rows[0].id,
        snapshotSha,
        snapshot,
      ],
    );
    ofId = of.rows[0]!.id;
    await tx.query(
      `INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by)
      VALUES($1,$2::uuid,$3::jsonb,$4,12)`,
      [ofId, piece.rows[0].version_id, snapshot, snapshotSha],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
  const revisionId = randomUUID();
  await db.query(
    `INSERT INTO public.of_revisions(id,of_id,statut,revision_rank,revision_code,motif,snapshot,snapshot_sha256)
    VALUES($1::uuid,$2,'ACTIVE',1,'R01','E2E','{}'::jsonb,repeat('b',64))`,
    [revisionId, ofId],
  );
  const operation = await db.query<{ id: string }>(
    `INSERT INTO public.of_operations(of_id,phase,designation,revision_id,status)
    VALUES($1,10,'Opération E2E AR',$2::uuid,'READY') RETURNING id::text AS id`,
    [ofId, revisionId],
  );
  const eventId = randomUUID();
  await db.query(
    `INSERT INTO public.planning_events(id,title,of_operation_id,status,start_ts,end_ts,machine_id)
    VALUES($1::uuid,'Créneau E2E AR',$2,'PLANNED',now()+($4::bigint * interval '2 hours'),now()+($4::bigint * interval '2 hours')+interval '1 hour',$3::uuid)`,
    [eventId, operation.rows[0].id, machine.rows[0].id, orderId],
  );
  return { orderId, eventId };
}

async function runArchiveWorker(): Promise<void> {
  const worker =
    await import("../shared/authoritative-documents/authoritative-document.worker");
  const claimed = await worker.runAuthoritativePdfArchiveWorkerOnce(
    undefined,
    "ar-http-e2e-worker",
  );
  expect(claimed).toBeGreaterThanOrEqual(1);
}

async function assertRetainedImmutableEvidence(orderId: number): Promise<void> {
  const evidence = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
    FROM public.ordres_fabrication WHERE commande_id=$1`,
    [orderId],
  );
  expect(Number(evidence.rows[0]?.count ?? 0)).toBe(1);
}

suite("AR HTTP full path — isolated PostgreSQL", () => {
  beforeAll(async () => {
    requireIsolatedDatabase();
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "cerp-ar-http-e2e-"));
    process.env.CERP_STORAGE_ROOT = storageRoot;
    process.env.CERP_GED_VAULT_ROOT = storageRoot;
    process.env.CERP_EMAIL_TEST_MODE = "1";
    process.env.RESEND_API_KEY = "local-ar-e2e-key";
    process.env.RESEND_FROM = "no-reply@example.local";
    process.env.JWT_SECRET ??= "j".repeat(40);
    emailSink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        receivedEmails.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `local-${receivedEmails.length}` }));
      });
    });
    await new Promise<void>((resolve) =>
      emailSink.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = emailSink.address();
    if (!address || typeof address === "string")
      throw new Error("Local email sink unavailable");
    emailSinkUrl = `http://127.0.0.1:${address.port}`;
    process.env.RESEND_API_BASE_URL = emailSinkUrl;
    db = new Pool({ connectionString: databaseUrl });
    await repairAbandonedSecretaryFixtures();
    await seedOrdinarySecretary();
    app = (await import("../config/app")).default;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => emailSink?.close(() => resolve()));
    if (secretary?.id)
      await db
        .query("UPDATE public.users SET status='Inactive' WHERE id=$1", [
          secretary.id,
        ])
        .catch(() => undefined);
    await db?.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("generates, archives, previews and sends one AR exactly once through the local test transport", async () => {
    const { orderId } = await seedReadyOrder(randomUUID());
    try {
      const profile = await request(app)
        .get("/api/v1/auth/access-profile")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);
      expect(profile.body.is_superadmin).toBe(false);
      expect(profile.body.modules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            module_key: "commandes-clients",
            allowed: true,
            source: "OVERRIDE",
          }),
        ]),
      );
      const me = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);
      expect(me.body.user).toMatchObject({
        id: secretary.id,
        role: "Secretaire",
      });
      const generated = await request(app)
        .post(`/api/v1/commandes/${orderId}/ar/generate`)
        .set("Authorization", `Bearer ${authToken()}`)
        .send({})
        .expect(201);
      expect(generated.body.status).toBe("GENERATED");
      await runArchiveWorker();

      const official = await request(app)
        .get(`/api/v1/commandes/${orderId}/acknowledgements`)
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);
      expect(official.body.state).toBe("READY");
      const archiveId = official.body.latest_document.id as string;
      const preview = await request(app)
        .get(
          `/api/v1/commandes/${orderId}/acknowledgements/${archiveId}/preview`,
        )
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);
      expect(preview.headers["content-type"]).toContain("application/pdf");
      expect(Buffer.isBuffer(preview.body)).toBe(true);

      const body = {
        ar_id: generated.body.ar_id,
        recipient_emails: ["client@outside.invalid"],
        recipient_contact_ids: [],
        email_body: "AR E2E contrôlé",
        idempotency_key: `ar-e2e-${randomUUID()}`,
      };
      const first = await request(app)
        .post(`/api/v1/commandes/${orderId}/ar/send`)
        .set("Authorization", `Bearer ${authToken()}`)
        .send(body)
        .expect(200);
      expect(first.body).toMatchObject({
        status: "AR_ENVOYE",
        ar_id: generated.body.ar_id,
        email_provider_id: "local-1",
      });
      expect(receivedEmails).toHaveLength(1);
      expect(receivedEmails[0]!.body.to).toEqual([secretary.email]);
      expect(receivedEmails[0]!.headers["idempotency-key"]).toBe(
        body.idempotency_key,
      );
      expect(
        (receivedEmails[0]!.body.attachments as unknown[]).length,
      ).toBeGreaterThanOrEqual(1);

      const replay = await request(app)
        .post(`/api/v1/commandes/${orderId}/ar/send`)
        .set("Authorization", `Bearer ${authToken()}`)
        .send(body)
        .expect(200);
      expect(replay.body).toMatchObject({
        status: "AR_ENVOYE",
        ar_id: generated.body.ar_id,
      });
      expect(receivedEmails).toHaveLength(1);
      const versions = await request(app).get(`/api/v1/commandes/${orderId}/ar`)
        .set("Authorization", `Bearer ${authToken()}`).expect(200);
      expect(versions.body.versions).toEqual([expect.objectContaining({ ar_id: generated.body.ar_id, status: "SENT" })]);
      const history = await db.query<{
        status: string;
        sent_at: string | null;
        archive_state: string;
        access_count: string;
      }>(
        `SELECT ar.status::text,ar.sent_at::text,o.status::text AS archive_state,
        (SELECT count(*)::text FROM public.ged_access_events e WHERE e.event_type IN ('AUTHORITATIVE_PDF_PREVIEWED','AUTHORITATIVE_PDF_SENT')) AS access_count
        FROM public.commande_ar_log ar JOIN public.authoritative_pdf_archives a ON a.source_snapshot->>'acknowledgement_id'=ar.id::text
        JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id=a.id WHERE ar.commande_id=$1`,
        [orderId],
      );
      expect(history.rows[0]).toMatchObject({
        status: "SENT",
        archive_state: "ARCHIVED",
      });
      expect(history.rows[0]!.sent_at).not.toBeNull();
      expect(Number(history.rows[0]!.access_count)).toBeGreaterThanOrEqual(2);
    } finally {
      await assertRetainedImmutableEvidence(orderId);
    }
  });

  it("blocks a generated AR if its only planned OF is cancelled before send, without calling transport", async () => {
    const { orderId, eventId } = await seedReadyOrder(randomUUID());
    try {
      const generated = await request(app)
        .post(`/api/v1/commandes/${orderId}/ar/generate`)
        .set("Authorization", `Bearer ${authToken()}`)
        .send({})
        .expect(201);
      await runArchiveWorker();
      await db.query(
        "UPDATE public.planning_events SET status='CANCELLED' WHERE id=$1::uuid",
        [eventId],
      );
      const before = receivedEmails.length;
      const refused = await request(app)
        .post(`/api/v1/commandes/${orderId}/ar/send`)
        .set("Authorization", `Bearer ${authToken()}`)
        .send({
          ar_id: generated.body.ar_id,
          recipient_emails: ["client@outside.invalid"],
          recipient_contact_ids: [],
          email_body: "Ne doit pas partir",
          idempotency_key: `ar-e2e-refused-${randomUUID()}`,
        })
        .expect(409);
      expect(refused.body.code).toBe("PLANNING_REQUIRES_PLANNED_OF");
      expect(receivedEmails).toHaveLength(before);
      const state = await db.query<{ status: string; sent_at: string | null }>(
        "SELECT status::text,sent_at::text FROM public.commande_ar_log WHERE id=$1::uuid",
        [generated.body.ar_id],
      );
      expect(state.rows[0]).toEqual({ status: "GENERATED", sent_at: null });
    } finally {
      await assertRetainedImmutableEvidence(orderId);
    }
  });
});
