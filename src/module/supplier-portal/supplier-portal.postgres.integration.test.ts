import { randomUUID } from "node:crypto";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../config/app";

const url = process.env.SUPPLIER_PORTAL_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let db: Pool,
  service: typeof import("./services/supplier-portal.service"),
  repo: typeof import("./repository/supplier-portal.repository"),
  monitor: typeof import("../commande-fournisseur/repository/supplier-promise-monitor.repository");
const patch = fs.readFileSync(
  path.resolve("db/patches/20261102_supplier_portal_pilot_1806.sql"),
  "utf8",
);
const treatmentPatch = fs.readFileSync(
  path.resolve(
    "db/patches/20261102_supplier_treatment_estimate_commands_1807.sql",
  ),
  "utf8",
);
const recoveryPatch = fs.readFileSync(
  path.resolve("db/patches/20261102_supplier_portal_recovery_request_1808.sql"),
  "utf8",
);

suite("supplier portal dormant pilot — isolated PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url)
      throw new Error(
        "SUPPLIER_PORTAL_TEST_DATABASE_URL must exactly match DATABASE_URL",
      );
    const target = new URL(url);
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.hostname) ||
      target.pathname !== "/cerp_test"
    )
      throw new Error("Refusing non-isolated database");
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.SUPPLIER_PORTAL_PILOT !== "1"
    )
      throw new Error("Explicit pilot opt-in required");
    db = new Pool({ connectionString: url });
    await db.query(patch);
    await db.query(treatmentPatch);
    await db.query(recoveryPatch);
    service = await import("./services/supplier-portal.service");
    repo = await import("./repository/supplier-portal.repository");
    monitor =
      await import("../commande-fournisseur/repository/supplier-promise-monitor.repository");
  });
  it("scopes invitation, activation, promise review and treatment estimate without changing the official promise", async () => {
    const tag = "PORTAL-" + randomUUID(),
      email = (tag + "@test.invalid").toLowerCase();
    const supplierA = (
      await db.query(
        "INSERT INTO fournisseurs(code,nom) VALUES($1,'Portal A') RETURNING id::text",
        [tag + "A"],
      )
    ).rows[0].id;
    const supplierB = (
      await db.query(
        "INSERT INTO fournisseurs(code,nom) VALUES($1,'Portal B') RETURNING id::text",
        [tag + "B"],
      )
    ).rows[0].id;
    const orderA = (
      await db.query(
        "INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ENVOYEE','MANUEL',$2::uuid) RETURNING id::text",
        [tag + "OA", supplierA],
      )
    ).rows[0].id;
    const orderB = (
      await db.query(
        "INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ENVOYEE','MANUEL',$2::uuid) RETURNING id::text",
        [tag + "OB", supplierB],
      )
    ).rows[0].id;
    const evidenceOrderA = (
      await db.query(
        "INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ACCUSE_RECU','MANUEL',$2::uuid) RETURNING id::text",
        [tag + "OE", supplierA],
      )
    ).rows[0].id;
    const lineA = (
      await db.query(
        "INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite,type) VALUES($1::uuid,'Traitement A',10,'SOUS_TRAITANCE') RETURNING id::text",
        [orderA],
      )
    ).rows[0].id;
    const lineB = (
      await db.query(
        "INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite) VALUES($1::uuid,'Traitement B',10) RETURNING id::text",
        [orderB],
      )
    ).rows[0].id;
    const invite = await service.invite({
      supplierId: supplierA,
      email,
      orderIds: [orderA],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const activationToken = new URL(
      "https://local" + invite.manual_url,
    ).searchParams.get("token")!;
    const activated = (
      await request(app)
        .post("/api/v1/supplier-portal/auth/activate")
        .send({
          token: activationToken,
          password: "portal-isolated-password",
          consent: true,
        })
        .expect(200)
    ).body;
    expect(activated.token).toEqual(expect.any(String));
    const login = (
      await request(app)
        .post("/api/v1/supplier-portal/auth/login")
        .send({ email, password: "portal-isolated-password" })
        .expect(200)
    ).body;
    const account = await repo.findAccountByEmail(email);
    expect(account?.supplier_id).toBe(supplierA);
    const identity = {
      accountId: account!.id,
      supplierId: supplierA,
      sessionEpoch: account!.session_epoch,
    };
    const orders = (
      await request(app)
        .get("/api/v1/supplier-portal/orders")
        .set("Authorization", `Bearer ${login.token}`)
        .expect(200)
    ).body.items;
    expect(orders).toHaveLength(1);
    expect(orders[0].line_id).toBe(lineA);
    await request(app)
      .get("/api/v1/supplier-portal/orders")
      .set("Authorization", `Bearer ${activated.token}`)
      .expect(200)
      .expect((response) => expect(response.body.items).toHaveLength(1));
    const proposal = (
      await request(app)
        .put(`/api/v1/supplier-portal/orders/${orderA}/lines/${lineA}/promise`)
        .set("Authorization", `Bearer ${login.token}`)
        .set("If-Match", orders[0].version)
        .set("Idempotency-Key", "portal-key-0001")
        .send({
          promised_date: "2026-12-20",
          promised_quantity: 4,
          reason: "Charge confirmée",
          estimated_treatment_return_date: "2026-12-18",
          estimate_reason: "Délai traitement estimé",
        })
        .expect(201)
    ).body;
    expect(proposal.status).toBe("PENDING");
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        service.promise(identity, {
          orderId: orderA,
          lineId: lineA,
          date: "2026-12-21",
          quantity: 2,
          reason: "Même demande rejouée",
          version: orders[0].version,
          key: "portal-concurrent-0001",
          estimatedReturn: null,
          estimateReason: null,
        }),
      ),
    );
    expect(concurrent.filter((result) => result.replayed)).toHaveLength(1);
    expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1);
    await expect(
      service.promise(identity, {
        orderId: orderB,
        lineId: lineB,
        date: "2026-12-20",
        quantity: 4,
        reason: "Cross tenant",
        version: orders[0].version,
        key: "portal-key-0002",
        estimatedReturn: null,
        estimateReason: null,
      }),
    ).rejects.toMatchObject({ code: "SUPPLIER_PORTAL_ORDER_LINE_NOT_FOUND" });
    await expect(
      service.promise(identity, {
        orderId: orderA,
        lineId: lineA,
        date: "2026-12-20",
        quantity: 11,
        reason: "Too much",
        version: orders[0].version,
        key: "portal-key-0003",
        estimatedReturn: null,
        estimateReason: null,
      }),
    ).rejects.toMatchObject({
      code: "SUPPLIER_PORTAL_QUANTITY_EXCEEDS_REMAINING",
    });
    const actor = Number(
      (await db.query("SELECT id FROM users WHERE is_superadmin LIMIT 1"))
        .rows[0].id,
    );
    const mfa = (
      await db.query(
        "SELECT id::text AS mfa_factor_id,version AS mfa_factor_version FROM user_mfa_factors WHERE user_id=$1 AND state='ACTIVE' LIMIT 1",
        [actor],
      )
    ).rows[0];
    const erpToken = jwt.sign(
      {
        id: actor,
        username: "test-admin",
        email: "test-admin@test.invalid",
        role: "Administrateur Systeme et Reseau",
        mfa: true,
        amr: ["totp"],
        mfa_verified_at: Math.floor(Date.now() / 1000),
        mfa_factor_id: mfa.mfa_factor_id,
        mfa_factor_version: mfa.mfa_factor_version,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "5m" },
    );
    const estimatePayload = {
      estimated_return_date: "2026-12-17",
      reason: "Estimation interne atelier traitement",
      source_version: "line-version-0001",
    };
    const estimateKey = `treatment-${tag}`;
    const estimate = await request(app)
      .put(
        `/api/v1/commandes-fournisseurs/${orderA}/lignes/${lineA}/treatment-estimate`,
      )
      .set("Authorization", `Bearer ${erpToken}`)
      .set("Idempotency-Key", estimateKey)
      .send(estimatePayload)
      .expect(200);
    expect(estimate.body).toMatchObject({
      promise_state: "ESTIMATED_NOT_CONFIRMED",
      idempotency_replayed: false,
    });
    await request(app)
      .put(
        `/api/v1/commandes-fournisseurs/${orderA}/lignes/${lineA}/treatment-estimate`,
      )
      .set("Authorization", `Bearer ${erpToken}`)
      .set("Idempotency-Key", estimateKey)
      .send(estimatePayload)
      .expect(200)
      .expect("Idempotency-Replayed", "true");
    await request(app)
      .put(
        `/api/v1/commandes-fournisseurs/${orderA}/lignes/${lineA}/treatment-estimate`,
      )
      .set("Authorization", `Bearer ${erpToken}`)
      .set("Idempotency-Key", estimateKey)
      .send({ ...estimatePayload, reason: "Payload différent" })
      .expect(409);
    await request(app)
      .get(`/api/v1/commandes-fournisseurs/${orderA}/treatment-estimates`)
      .set("Authorization", `Bearer ${erpToken}`)
      .expect(200)
      .expect((r) => expect(r.body.items).toHaveLength(1));
    const estimatedException = (
      await monitor.readSupplierPromiseExceptions("2026-12-01")
    ).find((item) => item.id === lineA);
    expect(estimatedException).toMatchObject({
      estimatedReturnDate: "2026-12-17",
      promiseEvidence: "ESTIMATED_NOT_CONFIRMED",
      promisedDate: null,
    });
    const reviewed = (
      await request(app)
        .post(
          `/api/v1/supplier-portal-admin/promise-reviews/${proposal.id}/decision`,
        )
        .set("Authorization", `Bearer ${erpToken}`)
        .set("Idempotency-Key", "review-key-0001")
        .send({
          decision: "ACCEPT",
          note: "A soumettre au circuit Achats officiel.",
        })
        .expect(200)
    ).body;
    expect(reviewed.status).toBe("ACCEPTED");
    expect(
      (
        await db.query(
          "SELECT date_promesse FROM commande_fournisseur_ligne WHERE id=$1::uuid",
          [lineA],
        )
      ).rows[0].date_promesse,
    ).toBeNull();
    const replay = (
      await request(app)
        .post(
          `/api/v1/supplier-portal-admin/promise-reviews/${proposal.id}/decision`,
        )
        .set("Authorization", `Bearer ${erpToken}`)
        .set("Idempotency-Key", "review-key-0001")
        .send({
          decision: "ACCEPT",
          note: "A soumettre au circuit Achats officiel.",
        })
        .expect(200)
    ).body;
    expect(replay.replayed).toBe(true);

    const staleOrders = await service.orders(identity);
    const staleProposal = await service.promise(identity, {
      orderId: orderA,
      lineId: lineA,
      date: "2026-12-23",
      quantity: 2,
      reason: "À rendre périmée",
      version: staleOrders[0].version,
      key: "portal-stale-0001",
      estimatedReturn: null,
      estimateReason: null,
    });
    await db.query(
      "UPDATE commande_fournisseur_ligne SET quantite=9,updated_at=now() WHERE id=$1::uuid",
      [lineA],
    );
    await expect(
      service.decide(
        staleProposal.id,
        "ACCEPT",
        "Ne doit pas passer après modification.",
        actor,
        "review-stale-0001",
      ),
    ).rejects.toMatchObject({ code: "SUPPLIER_PORTAL_REVIEW_STALE" });
    expect(
      (
        await db.query(
          "SELECT status FROM supplier_portal_promise_reviews WHERE id=$1::uuid",
          [staleProposal.id],
        )
      ).rows[0].status,
    ).toBe("PENDING");

    await request(app)
      .post("/api/v1/supplier-portal/auth/recover")
      .send({ email })
      .expect(202);
    const recoveryAccess = await request(app)
      .get("/api/v1/supplier-portal-admin/access")
      .set("Authorization", `Bearer ${erpToken}`)
      .expect(200);
    expect(recoveryAccess.body.items ?? recoveryAccess.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: account!.id,
          recovery_requested_at: expect.any(String),
        }),
      ]),
    );
    const reset = (
      await request(app)
        .post(`/api/v1/supplier-portal-admin/accounts/${account!.id}/reset`)
        .set("Authorization", `Bearer ${erpToken}`)
        .expect(200)
    ).body;
    const resetToken = new URL(
      "https://local" + reset.manual_url,
    ).searchParams.get("token")!;
    await request(app)
      .post("/api/v1/supplier-portal/auth/reset")
      .send({ token: resetToken, password: "new-isolated-password" })
      .expect(200);
    await request(app)
      .post("/api/v1/supplier-portal/auth/login")
      .send({ email, password: "portal-isolated-password" })
      .expect(401);
    await request(app)
      .post("/api/v1/supplier-portal/auth/login")
      .send({ email, password: "new-isolated-password" })
      .expect(200);
    const disabledReset = (
      await request(app)
        .post(`/api/v1/supplier-portal-admin/accounts/${account!.id}/reset`)
        .set("Authorization", `Bearer ${erpToken}`)
        .expect(200)
    ).body;
    const disabledResetToken = new URL(
      "https://local" + disabledReset.manual_url,
    ).searchParams.get("token")!;
    await request(app)
      .post(`/api/v1/supplier-portal-admin/access/${account!.id}/disable`)
      .set("Authorization", `Bearer ${erpToken}`)
      .expect(200);
    await request(app)
      .post("/api/v1/supplier-portal/auth/reset")
      .send({ token: disabledResetToken, password: "must-not-activate" })
      .expect(409);
    await request(app)
      .post("/api/v1/supplier-portal/auth/login")
      .send({ email, password: "new-isolated-password" })
      .expect(401);

    await db.query(
      `UPDATE supplier_portal_configuration SET enabled=true,pilot_supplier_id=$1::uuid,evidence_order_ids=$2::uuid[],
       purchasing_owner_user_id=$3,support_owner_user_id=$3,administrator_user_ids=ARRAY[$3]::integer[],
       approved_policy_version='pilot-evidence-v1',consent_and_export_controlled=true,dedicated_secret_configured=true,approved_at=now()
       WHERE id=true`,
      [supplierA, [orderA, evidenceOrderA], actor],
    );
    expect(await repo.supplierPortalProofGate()).toBe(true);
    expect(login.token).toEqual(expect.any(String));
  });
});
afterAll(async () => {
  await db?.end();
});
