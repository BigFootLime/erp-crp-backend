import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPPLIER_PORTAL_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let db: Pool,
  service: typeof import("./services/supplier-portal.service"),
  repo: typeof import("./repository/supplier-portal.repository");
const patch = fs.readFileSync(
  path.resolve("db/patches/20261102_supplier_portal_pilot_1806.sql"),
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
    service = await import("./services/supplier-portal.service");
    repo = await import("./repository/supplier-portal.repository");
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
        "INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite) VALUES($1::uuid,'Traitement A',10) RETURNING id::text",
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
    const activated = await service.activate({
      token: activationToken,
      password: "portal-isolated-password",
      consent: true,
    });
    expect(activated.token).toEqual(expect.any(String));
    const login = await service.login({
      email,
      password: "portal-isolated-password",
    });
    const account = await repo.findAccountByEmail(email);
    expect(account?.supplier_id).toBe(supplierA);
    const identity = {
      accountId: account!.id,
      supplierId: supplierA,
      sessionEpoch: account!.session_epoch,
    };
    const orders = await service.orders(identity);
    expect(orders).toHaveLength(1);
    expect(orders[0].line_id).toBe(lineA);
    const proposal = await service.promise(identity, {
      orderId: orderA,
      lineId: lineA,
      date: "2026-12-20",
      quantity: 4,
      reason: "Charge confirmée",
      version: orders[0].version,
      key: "portal-key-0001",
      estimatedReturn: "2026-12-18",
      estimateReason: "Délai traitement estimé",
    });
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
    const reviewed = await service.decide(
      proposal.id,
      "ACCEPT",
      "A soumettre au circuit Achats officiel.",
      actor,
      "review-key-0001",
    );
    expect(reviewed.status).toBe("ACCEPTED");
    expect(
      (
        await db.query(
          "SELECT date_promesse FROM commande_fournisseur_ligne WHERE id=$1::uuid",
          [lineA],
        )
      ).rows[0].date_promesse,
    ).toBeNull();
    const replay = await service.decide(
      proposal.id,
      "ACCEPT",
      "A soumettre au circuit Achats officiel.",
      actor,
      "review-key-0001",
    );
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

    const reset = await service.resetByAdmin(account!.id);
    const resetToken = new URL(
      "https://local" + reset.manual_url,
    ).searchParams.get("token")!;
    await db.query(
      "UPDATE supplier_portal_accounts SET account_status='DISABLED',session_epoch=session_epoch+1 WHERE id=$1::uuid",
      [account!.id],
    );
    await expect(
      service.reset({ token: resetToken, password: "new-isolated-password" }),
    ).rejects.toMatchObject({ code: "SUPPLIER_PORTAL_ACCOUNT_DISABLED" });
    await expect(
      service.login({ email, password: "portal-isolated-password" }),
    ).rejects.toMatchObject({ code: "SUPPLIER_PORTAL_LOGIN_INVALID" });

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
