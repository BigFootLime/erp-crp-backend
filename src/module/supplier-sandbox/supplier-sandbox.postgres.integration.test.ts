import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPPLIER_SANDBOX_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let db: Pool;
let appPool: Pool;
let service: typeof import("./services/supplier-sandbox.service");
const patch = fs.readFileSync(
  path.resolve("db/patches/20261031_supplier_sandbox_1803.sql"),
  "utf8",
);

suite("supplier sandbox — isolated PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url)
      throw new Error(
        "SUPPLIER_SANDBOX_TEST_DATABASE_URL must exactly match DATABASE_URL",
      );
    const target = new URL(url);
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.hostname) ||
      target.pathname !== "/cerp_test"
    )
      throw new Error("Refusing a non-isolated supplier sandbox database");
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.SUPPLIER_PORTAL_SANDBOX !== "1"
    )
      throw new Error(
        "Supplier sandbox must be explicitly enabled for the isolated test",
      );
    db = new Pool({ connectionString: url });
    const c = await db.connect();
    try {
      await c.query("SET cerp.e2e_isolated='on'");
      await c.query(patch);
    } finally {
      c.release();
    }
    appPool = (await import("../../config/database")).default;
    service = await import("./services/supplier-sandbox.service");
  });

  it("isolates supplier lines and makes replay, payload mismatch and concurrent retries deterministic", async () => {
    const tag = `SUPPLIER-SANDBOX-${randomUUID()}`;
    const client = await db.connect();
    try {
      const supplierA = (
        await client.query(
          "INSERT INTO fournisseurs(code,nom) VALUES($1,'Sandbox supplier A') RETURNING id::text",
          [`${tag}-A`],
        )
      ).rows[0].id;
      const supplierB = (
        await client.query(
          "INSERT INTO fournisseurs(code,nom) VALUES($1,'Sandbox supplier B') RETURNING id::text",
          [`${tag}-B`],
        )
      ).rows[0].id;
      const orderA = (
        await client.query(
          "INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ENVOYEE','MANUEL',$2::uuid) RETURNING id::text",
          [`${tag}-OA`, supplierA],
        )
      ).rows[0].id;
      const orderB = (
        await client.query(
          "INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ENVOYEE','MANUEL',$2::uuid) RETURNING id::text",
          [`${tag}-OB`, supplierB],
        )
      ).rows[0].id;
      const lineA = (
        await client.query(
          "INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite) VALUES($1::uuid,'A line',10) RETURNING id::text",
          [orderA],
        )
      ).rows[0].id;
      const lineB = (
        await client.query(
          "INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite) VALUES($1::uuid,'B line',10) RETURNING id::text",
          [orderB],
        )
      ).rows[0].id;
      const passwordHash = await bcrypt.hash("supplier-sandbox-password", 10);
      const accountA = (
        await client.query(
          "INSERT INTO supplier_sandbox_accounts(supplier_id,email_normalized,password_hash) VALUES($1::uuid,$2,$3) RETURNING id::text",
          [supplierA, `${tag}-a@test.invalid`.toLowerCase(), passwordHash],
        )
      ).rows[0].id;
      const accountA2 = (
        await client.query(
          "INSERT INTO supplier_sandbox_accounts(supplier_id,email_normalized,password_hash) VALUES($1::uuid,$2,$3) RETURNING id::text",
          [supplierA, `${tag}-a2@test.invalid`.toLowerCase(), passwordHash],
        )
      ).rows[0].id;
      const identity = {
        accountId: accountA,
        supplierId: supplierA,
        sessionEpoch: 0,
      };
      const otherUser = {
        accountId: accountA2,
        supplierId: supplierA,
        sessionEpoch: 0,
      };
      const listed = await service.listSupplierSandboxLines(identity);
      expect(listed).toHaveLength(1);
      expect(listed[0].line_id).toBe(lineA);
      const body = {
        order_id: orderA,
        line_id: lineA,
        promised_date: "2026-12-15",
        promised_quantity: 4,
        reason: "Capacity confirmed",
      };
      const created = await service.submitSupplierSandboxPromise(
        identity,
        body,
        "supplier-key-0001",
      );
      expect(created.replayed).toBe(false);
      await expect(
        service.submitSupplierSandboxPromise(
          identity,
          { ...body, promised_quantity: 5 },
          "supplier-key-0001",
        ),
      ).rejects.toMatchObject({
        code: "SUPPLIER_SANDBOX_IDEMPOTENCY_PAYLOAD_MISMATCH",
      });
      await expect(
        service.submitSupplierSandboxPromise(
          identity,
          { ...body, order_id: orderB, line_id: lineB },
          "supplier-key-0002",
        ),
      ).rejects.toMatchObject({ code: "SUPPLIER_SANDBOX_LINE_NOT_FOUND" });
      // Keys are account-bound: another authenticated user must not obtain this user's replay.
      const secondUser = await service.submitSupplierSandboxPromise(
        otherUser,
        body,
        "supplier-key-0001",
      );
      expect(secondUser.replayed).toBe(false);
      expect(secondUser.id).not.toBe(created.id);
      const concurrent = await Promise.all([
        service.submitSupplierSandboxPromise(
          identity,
          { ...body, promised_date: "2026-12-16" },
          "supplier-key-0003",
        ),
        service.submitSupplierSandboxPromise(
          identity,
          { ...body, promised_date: "2026-12-16" },
          "supplier-key-0003",
        ),
      ]);
      expect(concurrent.filter((x) => x.replayed)).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});
afterAll(async () => {
  await appPool?.end();
  await db?.end();
});
