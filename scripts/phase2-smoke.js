/* eslint-disable no-console */

// Phase 2 smoke test (integration): livraisons allocations -> stock issue on READY->SHIPPED.
// Usage: node scripts/phase2-smoke.js

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret";

const http = require("http");
const crypto = require("crypto");

const jwt = require("jsonwebtoken");
const { Client } = require("pg");

const appMod = require("../dist/config/app");
const app = appMod.default ?? appMod;
const stockRepo = require("../dist/module/stock/repository/stock.repository");

async function asJson(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  try {
    const suf = crypto.randomUUID().slice(0, 8);

    const clientId = (await pg.query("SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1")).rows[0]?.client_id;
    const userIdRaw = (await pg.query("SELECT id FROM public.users ORDER BY id LIMIT 1")).rows[0]?.id;
    const userId = Number(userIdRaw);
    if (!clientId || !Number.isFinite(userId)) throw new Error("Missing seed client/user");

  // Seed warehouse/location/magasin/emplacement (with mapping: emplacement.location_id -> location.warehouse_id)
  const warehouseId = (
    await pg.query(
      "INSERT INTO public.warehouses (id, code, name, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id::text AS id",
      [`SMOKE2-WH-${suf}`, `Smoke2 WH ${suf}`]
    )
  ).rows[0]?.id;

  const locationId = (
    await pg.query(
      "INSERT INTO public.locations (id, warehouse_id, code, description, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, now(), now()) RETURNING id::text AS id",
      [warehouseId, `SMOKE2-LOC-${suf}`, `Smoke2 loc ${suf}`]
    )
  ).rows[0]?.id;

  const magasinCode = `SMOKE2-${suf}`;
  const magasinId = (
    await pg.query(
      "INSERT INTO public.magasins (id, code_magasin, libelle, is_active, code, name, warehouse_id, created_by, updated_by) VALUES (gen_random_uuid(), $1::text, $2::text, true, $1::text, $2::text, $3::uuid, $4, $4) RETURNING id::text AS id",
      [magasinCode, `Smoke2 magasin ${suf}`, warehouseId, userId]
    )
  ).rows[0]?.id;

  const emplacementId = (
    await pg.query(
      "INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, location_id, created_at, updated_at, created_by, updated_by) VALUES ($1::uuid, $2, $3, false, true, $4::uuid, now(), now(), $5, $5) RETURNING id::int AS id",
      [magasinId, `SMOKE2-EM-${suf}`, `Smoke2 emp ${suf}`, locationId, userId]
    )
  ).rows[0]?.id;

  if (!warehouseId || !locationId || !magasinId || !emplacementId) throw new Error("Failed to seed stock location entities");

  // Configure deterministic shipping location
  await pg.query(
    "INSERT INTO public.erp_settings (key, value_json, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $3) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now(), updated_by = EXCLUDED.updated_by",
    ["stock.default_shipping_location", JSON.stringify({ magasin_id: magasinId, emplacement_id: emplacementId }), userId]
  );

  // Seed article + lot
  const articleCode = `SMOKE2-PART-${suf}`;
  const articleId = (
    await pg.query(
      "INSERT INTO public.articles (code, designation, article_type, unite, lot_tracking, is_active, created_at, updated_at, created_by, updated_by) VALUES ($1, $2, 'PURCHASED', 'u', true, true, now(), now(), $3, $3) RETURNING id::text AS id",
      [articleCode, `Smoke2 part ${suf}`, userId]
    )
  ).rows[0]?.id;

  const lotCode = `LOT-${suf}`;
  const lotId = (
    await pg.query(
      "INSERT INTO public.lots (article_id, lot_code, created_at, updated_at, created_by, updated_by) VALUES ($1::uuid, $2, now(), now(), $3, $3) RETURNING id::text AS id",
      [articleId, lotCode, userId]
    )
  ).rows[0]?.id;

  if (!articleId || !lotId) throw new Error("Failed to seed article/lot");

  const audit = {
    user_id: userId,
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
    path: "/smoke2",
    page_key: "smoke2",
    client_session_id: null,
  };

  // Receipt stock: +10
  const inMov = await stockRepo.repoCreateMovement(
    {
      movement_type: "IN",
      effective_at: new Date().toISOString(),
      source_document_type: "SMOKE2",
      source_document_id: suf,
      reason_code: "SMOKE2_RECEIPT",
      notes: `Smoke2 receipt ${suf}`,
      idempotency_key: `smoke2:${suf}:in:${articleId}:${lotId}`,
      lines: [
        {
          line_no: 1,
          article_id: articleId,
          lot_id: lotId,
          qty: 10,
          unite: "u",
          dst_magasin_id: magasinId,
          dst_emplacement_id: emplacementId,
          note: "receipt",
        },
      ],
    },
    audit
  );
  await stockRepo.repoPostMovement(inMov.movement.id, audit);

  const beforeLevel = (
    await pg.query(
      "SELECT qty_total::float8 AS qty_total FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid",
      [articleId, locationId]
    )
  ).rows[0]?.qty_total;

  // Start API server
  const server = http.createServer(app);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())));

  try {
    const port = server.address().port;
    const token = jwt.sign({ id: userId, username: "smoke", email: "smoke@example.test", role: "ADMIN" }, process.env.JWT_SECRET, {
      expiresIn: "10m",
    });

    const base = `http://127.0.0.1:${port}`;
    const hJson = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const hAuth = { Authorization: `Bearer ${token}` };

    // Create BL with one line
    const createRes = await fetch(`${base}/api/v1/livraisons`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({
        client_id: String(clientId),
        commentaire_interne: `smoke2 ${suf}`,
        lignes: [{ designation: `Smoke2 line ${suf}`, code_piece: "IGNORED", quantite: 3, unite: "u" }],
      }),
    });
    const createBody = await asJson(createRes);
    if (createRes.status !== 201) throw new Error(`create livraison ${createRes.status}: ${JSON.stringify(createBody)}`);
    const blId = createBody.id;

    // Fetch detail to get line id
    const get1 = await fetch(`${base}/api/v1/livraisons/${blId}`, { headers: hAuth });
    const getBody1 = await asJson(get1);
    if (!get1.ok) throw new Error(`get livraison ${get1.status}: ${JSON.stringify(getBody1)}`);
    const lineId = getBody1?.lignes?.[0]?.id;
    if (typeof lineId !== "string") throw new Error(`missing lineId: ${JSON.stringify(getBody1)}`);

    // DRAFT -> READY
    const readyRes = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({ statut: "READY", commentaire: "smoke2" }),
    });
    if (!readyRes.ok) throw new Error(`READY ${readyRes.status}: ${JSON.stringify(await asJson(readyRes))}`);

    // READY -> SHIPPED without allocations should fail 400
    const shipNoAlloc = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({ statut: "SHIPPED", commentaire: "smoke2" }),
    });
    const shipNoAllocBody = await asJson(shipNoAlloc);
    if (shipNoAlloc.status !== 400) {
      throw new Error(
        `Expected 400 when shipping without allocations, got ${shipNoAlloc.status}: ${JSON.stringify(shipNoAllocBody)}`
      );
    }

    // Add allocation
    const allocRes = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${lineId}/allocations`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({ article_id: articleId, lot_id: lotId, quantite: 3, unite: "u" }),
    });
    const allocBody = await asJson(allocRes);
    if (allocRes.status !== 201) throw new Error(`alloc ${allocRes.status}: ${JSON.stringify(allocBody)}`);
    const allocationId = allocBody.allocationId;
    if (typeof allocationId !== "string") throw new Error(`alloc response missing allocationId: ${JSON.stringify(allocBody)}`);

    // (Optional) delete allocation and re-create, to smoke test DELETE endpoint
    const delAlloc = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${lineId}/allocations/${allocationId}`, {
      method: "DELETE",
      headers: hJson,
    });
    if (delAlloc.status !== 204) throw new Error(`delete allocation ${delAlloc.status}: ${JSON.stringify(await asJson(delAlloc))}`);

    const allocRes2 = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${lineId}/allocations`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({ article_id: articleId, lot_id: lotId, quantite: 3, unite: "u" }),
    });
    const allocBody2 = await asJson(allocRes2);
    if (allocRes2.status !== 201) throw new Error(`alloc2 ${allocRes2.status}: ${JSON.stringify(allocBody2)}`);
    const allocationId2 = allocBody2.allocationId;
    if (typeof allocationId2 !== "string") throw new Error(`alloc2 response missing allocationId: ${JSON.stringify(allocBody2)}`);

    // Ship
    const shipRes = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
      method: "POST",
      headers: hJson,
      body: JSON.stringify({ statut: "SHIPPED", commentaire: "smoke2" }),
    });
    const shipBody = await asJson(shipRes);
    if (!shipRes.ok) throw new Error(`SHIPPED ${shipRes.status}: ${JSON.stringify(shipBody)}`);

    // Fetch detail and ensure allocations include stock_movement_line_id
    const get2 = await fetch(`${base}/api/v1/livraisons/${blId}`, { headers: hAuth });
    const getBody2 = await asJson(get2);
    if (!get2.ok) throw new Error(`get2 ${get2.status}: ${JSON.stringify(getBody2)}`);

    const allocOut = getBody2?.lignes?.[0]?.allocations?.[0];
    const stockMovementLineId = allocOut?.stock_movement_line_id;
    if (typeof stockMovementLineId !== "string" || !stockMovementLineId) {
      throw new Error(`Missing stock_movement_line_id in GET: ${JSON.stringify(getBody2)}`);
    }

    // DB verification
    const allocDb = await pg.query(
      "SELECT id::text AS id, stock_movement_line_id::text AS stock_movement_line_id FROM public.bon_livraison_ligne_allocations WHERE id = $1::uuid",
      [allocationId2]
    );

    const movements = await pg.query(
      "SELECT id::text AS id, movement_type::text AS movement_type, status, qty::float8 AS qty FROM public.stock_movements WHERE source_document_type = 'BON_LIVRAISON' AND source_document_id = $1 ORDER BY created_at ASC, id ASC",
      [blId]
    );

    const afterLevel = (
      await pg.query(
        "SELECT qty_total::float8 AS qty_total FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid",
        [articleId, locationId]
      )
    ).rows[0]?.qty_total;

    const trace = await pg.query(
      "SELECT a.id::text AS allocation_id, a.article_id::text AS article_id, a.lot_id::text AS lot_id, sml.id::text AS stock_movement_line_id, sm.id::text AS stock_movement_id, sm.movement_no, sm.status, sm.qty::float8 AS movement_qty FROM public.bon_livraison_ligne_allocations a JOIN public.stock_movement_lines sml ON sml.id = a.stock_movement_line_id JOIN public.stock_movements sm ON sm.id = sml.movement_id WHERE a.id = $1::uuid",
      [allocationId2]
    );

    console.log(
      JSON.stringify({
        blId,
        lineId,
        allocationId: allocationId2,
        stockMovementLineId,
        stockLevels: { before: beforeLevel, after: afterLevel },
        linkedMovements: movements.rows,
        allocationDb: allocDb.rows[0] ?? null,
        trace: trace.rows[0] ?? null,
      })
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  } finally {
    await pg.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("PHASE2_SMOKE_FAIL", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
