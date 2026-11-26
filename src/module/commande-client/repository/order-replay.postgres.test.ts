import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { errorHandler } from "../../../middlewares/errorHandler";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import {
  createPilotFixtureClient,
  createPilotFixtureArticle,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
import { seedWorkbenchStock } from "../../../__tests__/fixtures/production-workbench.fixture";
import commercialReliability from "../../commercial-reliability/routes/commercial-reliability.routes";
import orders from "../routes/commande-client.routes";
import {
  repoCreateCommandeDraftTx,
  repoListCommandes,
} from "./commande-client.repository";
import { repoCancelOrder } from "../../commercial-reliability/repository/commercial-reliability.repository";
import { listCommandesQuerySchema } from "../validators/commande-client.validators";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";

async function seedCancellation() {
  const actor = Number((await pool.query("SELECT id FROM public.users WHERE is_superadmin ORDER BY id LIMIT 1")).rows[0]?.id);
  expect(actor).toBeGreaterThan(0);
  const article = randomUUID(), code = `CX-${article.slice(0, 8)}`;
  const identity = await industrialTx(async tx => {
    const client = await createPilotFixtureClient(tx, "K", "Client de recette annulation");
    const { piece, version } = await createPilotFixtureArticle(tx, client, actor, article, code);
    const order = await repoCreateCommandeDraftTx(tx, {
      client_id: client, code_client: code, date_commande: "2030-01-02",
      lignes: [{ article_id: article, designation: code, quantite: 3, prix_unitaire_ht: 5, taux_tva: 20 }],
    }, actor, "client_demand");
    const line = (await tx.query("SELECT id::text FROM public.commande_ligne WHERE commande_id=$1", [order.id])).rows[0].id;
    const ofId = (await tx.query(`INSERT INTO public.ordres_fabrication
      (numero,commande_id,commande_ligne_id,client_id,piece_technique_id,article_id,quantite_lancee,statut,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,3,'BROUILLON',$7,$7) RETURNING id::text`,
    [code, order.id, line, client, piece, article, actor])).rows[0].id;
    const revision = (await tx.query(`INSERT INTO public.of_revisions(of_id,revision_rank,revision_code,snapshot,snapshot_sha256,author_user_id,statut)
      VALUES($1,0,'R00','{}',repeat('a',64),$2,'ACTIVE') RETURNING id::text`, [ofId, actor])).rows[0].id;
    const operation = (await tx.query(`INSERT INTO public.of_operations(of_id,revision_id,phase,designation)
      VALUES($1,$2,20,'Fraisage de recette') RETURNING id::text`, [ofId, revision])).rows[0].id;
    const event = (await tx.query(`INSERT INTO public.planning_events(id,of_id,of_operation_id,machine_id,title,start_ts,end_ts,allow_overlap)
      SELECT gen_random_uuid(),$1,$3,id,$2,'2030-02-01 08:00+01','2030-02-01 09:00+01',true FROM public.machines ORDER BY id LIMIT 1
      RETURNING id::text`, [ofId, code, operation])).rows[0]?.id;
    expect(event).toBeTruthy();
    await tx.query(`UPDATE public.planning_tasks SET forecast_start='2030-02-01 08:00+01',forecast_end='2030-02-01 09:00+01'
      WHERE operation_id=$1`, [operation]);
    return { orderId: order.id, line, ofId, event, version, piece, operation, revision };
  });
  const stock = await seedWorkbenchStock({ ...identity, article, code, audit: { user_id: actor } }, 30);
  const reservations = [randomUUID(), randomUUID()].sort();
  await industrialTx(async tx => {
    await tx.query("UPDATE public.stock_levels SET qty_reserved=5 WHERE id=$1", [stock.level]);
    await tx.query("UPDATE public.stock_batches SET qty_reserved=5 WHERE id=$1", [stock.batch]);
    await tx.query(`INSERT INTO public.stock_reservations
      (id,article_id,location_id,lot_id,stock_batch_id,qty_reserved,source_type,source_id,commande_ligne_id,of_id,reason,created_by,updated_by)
      VALUES($1,$3,$4,$5,$6,2,'COMMANDE_LIGNE',$7::bigint::text,$7,NULL,'Fixture commande',$9,$9),
            ($2,$3,$4,$5,$6,3,'OF',$8::bigint::text,NULL,$8,'Fixture OF',$9,$9)`,
    [...reservations, article, stock.location, stock.lot, stock.batch, identity.line, identity.ofId, actor]);
  });
  const route = `/orders/${identity.orderId}/cancel`;
  const app = express().use(express.json()).use((req, _res, next) => {
    req.user = { id: actor, role: "Directeur" } as typeof req.user;
    next();
  }).use(commercialReliability).use(errorHandler);
  const key = randomUUID();
  const cancel = () => request(app).post(route).set("Idempotency-Key", key).send({ reason_code: "CUSTOMER_CANCELLED" });
  const snapshot = async () => (await pool.query(`SELECT
    (SELECT statut::text FROM public.ordres_fabrication WHERE id=$1) AS of_status,
    (SELECT status::text FROM public.planning_events WHERE id=$2) AS slot_status,
    (SELECT archived_at IS NOT NULL FROM public.planning_events WHERE id=$2) AS slot_archived,
    (SELECT array_agg(status ORDER BY id) FROM public.stock_reservations WHERE id=ANY($3::uuid[])) AS reservations,
    (SELECT qty_total::float8 FROM public.stock_levels WHERE id=$4) AS physical,
    (SELECT qty_reserved::float8 FROM public.stock_levels WHERE id=$4) AS reserved,
    (SELECT qty_reserved::float8 FROM public.stock_batches WHERE id=$5) AS batch_reserved,
    (SELECT count(*)::int FROM public.stock_movements WHERE article_id=$6) AS movements,
    (SELECT count(*)::int FROM public.commercial_order_cancellations WHERE commande_id=$7) AS cancelled,
    (SELECT snapshot_sha256 FROM public.of_revisions WHERE id=$8) AS of_revision_hash,
    (SELECT forecast_end IS NOT NULL FROM public.planning_tasks WHERE operation_id=$9) AS has_forecast,
    (SELECT revision::text FROM public.planning_central_settings WHERE singleton) AS revision`,
  [identity.ofId, identity.event, reservations, stock.level, stock.batch, article, identity.orderId,
    identity.revision, identity.operation])).rows[0];
  return { ...identity, stock, reservations, cancel, snapshot };
}

describe.skipIf(!isolated)("Guided order retries and cancellation", () => {
  afterAll(async () => {
    await pool.end();
  });
  it("cancels unstarted production, removes its slot and releases stock once on concurrent replay", async () => {
    const f = await seedCancellation();
    const before = await f.snapshot();
    expect(before).toMatchObject({ of_status: "BROUILLON", slot_status: "PLANNED", reserved: 5, cancelled: 0, has_forecast: true });
    const responses = await Promise.all([f.cancel(), f.cancel()]);
    expect(responses.map(response => [response.status, response.body])).toEqual(expect.arrayContaining([
      [200, expect.objectContaining({ status: "ANNULE", idempotent_replay: false })],
      [200, expect.objectContaining({ status: "ANNULE", idempotent_replay: true })],
    ]));
    const after = await f.snapshot();
    expect(after).toMatchObject({ of_status: "ANNULE", slot_status: "CANCELLED", slot_archived: true,
      reservations: ["RELEASED", "RELEASED"], physical: before.physical, reserved: 0, batch_reserved: 0,
      movements: before.movements, cancelled: 1, of_revision_hash: before.of_revision_hash, has_forecast: false });
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    expect((await f.cancel()).body.idempotent_replay).toBe(true);
    expect(await f.snapshot()).toEqual(after);
  });

  it("rolls back the first release when a second reservation has already been prepared", async () => {
    const f = await seedCancellation();
    await pool.query("UPDATE public.stock_reservations SET qty_prepared=1 WHERE id=$1", [f.reservations[1]]);
    const before = await f.snapshot();
    const rejected = await f.cancel();
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(JSON.stringify(rejected.body)).toContain("RESERVATION_ALREADY_PREPARED");
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves the order when stock has already been consumed or fabrication launched", async () => {
    const f = await seedCancellation();
    await pool.query("UPDATE public.stock_reservations SET qty_consumed=1 WHERE id=$1", [f.reservations[0]]);
    const consumed = await f.snapshot();
    expect(JSON.stringify((await f.cancel()).body)).toContain("ORDER_STOCK_COMMITMENT");
    expect(await f.snapshot()).toEqual(consumed);
    await pool.query("UPDATE public.ordres_fabrication SET date_lancement_reelle=CURRENT_DATE WHERE id=$1", [f.ofId]);
    const started = await f.snapshot();
    expect(JSON.stringify((await f.cancel()).body)).toContain("OF_CANCELLATION_COMMITMENTS");
    expect(await f.snapshot()).toEqual(started);
  });

  it("backs off a concurrent lot writer before applying any part of the cancellation", async () => {
    const f = await seedCancellation();
    const before = await f.snapshot();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM public.lots WHERE id=$1 FOR UPDATE", [f.stock.lot]);
      const busy = await f.cancel();
      expect(busy.status, JSON.stringify(busy.body)).toBe(409);
      expect(JSON.stringify(busy.body)).toContain("ORDER_CANCELLATION_BUSY");
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect((await f.cancel()).status).toBe(200);
  });

  it("preserves a planned order already acknowledged to its client", async () => {
    const f = await seedCancellation();
    await pool.query("UPDATE public.commande_client SET ar_sent_at=now() WHERE id=$1", [f.orderId]);
    const before = await f.snapshot();
    const result = await f.cancel();
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(JSON.stringify(result.body)).toContain("PLANNING_LOCKED_AFTER_AR");
    expect(await f.snapshot()).toEqual(before);
  });
  it("retains one original PDF after repeated saves and closes only pending work on cancellation", async () => {
    const actorId = (
      await pool.query(
        "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
      )
    ).rows[0].id;
    const article = randomUUID(),
      code = "QA-" + article.slice(0, 8);
    const { order, client } = await industrialTx(async (tx) => {
      const client = await createPilotFixtureClient(
        tx,
        "K",
        "Annulation isolée",
      );
      await createPilotFixtureArticle(tx, client, actorId, article, code);
      const order = await repoCreateCommandeDraftTx(
        tx,
        {
          client_id: client,
          code_client: code,
          date_commande: "2030-01-02",
          lignes: [
            {
              article_id: article,
              designation: code,
              quantite: 1,
              prix_unitaire_ht: 5,
              taux_tva: 20,
            },
          ],
        },
        actorId,
        "client_demand",
      );
      return { order, client };
    });
    const line = (
      await pool.query(
        "SELECT id FROM public.commande_ligne WHERE commande_id=$1",
        [order.id],
      )
    ).rows[0].id;
    const payload = {
      client_id: client,
      code_client: code,
      date_commande: "2030-01-02",
      lignes: [
        {
          id: Number(line),
          article_id: article,
          designation: code,
          quantite: 1,
          prix_unitaire_ht: 5,
          taux_tva: 20,
          delai_client: "2030-02-01",
        },
      ],
    };
    const app = express()
      .use((req, _res, next) => {
        req.user = {
          id: actorId,
          role: "Administrateur Systeme et Reseau",
        } as typeof req.user;
        next();
      })
      .use("/orders", orders);
    const savedRoot = process.env.CERP_DOCUMENTS_ROOT;
    const isolatedDocuments = await mkdtemp(
      path.join(tmpdir(), "carco-document-qa-"),
    );
    process.env.CERP_DOCUMENTS_ROOT = isolatedDocuments;
    try {
      const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
      const update = () =>
        request(app)
          .patch("/orders/" + order.id)
          .field("data", JSON.stringify(payload))
          .attach("documents[]", pdf, {
            filename: "original.pdf",
            contentType: "application/pdf",
          });
      const first = await update();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await update();
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM public.commande_documents WHERE commande_id=$1",
            [order.id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      if (savedRoot === undefined) delete process.env.CERP_DOCUMENTS_ROOT;
      else process.env.CERP_DOCUMENTS_ROOT = savedRoot;
      if (
        path.dirname(isolatedDocuments) === path.resolve(tmpdir()) &&
        path.basename(isolatedDocuments).startsWith("carco-document-qa-")
      )
        await rm(isolatedDocuments, { recursive: true, force: true });
    }
    const doneBefore = (
      await pool.query(
        "SELECT count(*)::int n FROM public.commande_client_workflow_checkpoint WHERE commande_id=$1 AND status='done'",
        [order.id],
      )
    ).rows[0].n;
    await repoCancelOrder({
      commandeId: order.id,
      input: { reason_code: "CUSTOMER_CANCELLED", note: "Reprise exemple" },
      actor: {
        user_id: actorId,
        role: "Directeur",
        ip: null,
        user_agent: null,
        path: "/test/order",
        page_key: "commercial-reliability",
        client_session_id: null,
      },
      idempotencyKey: randomUUID(),
    });
    const statuses = (
      await pool.query(
        "SELECT status FROM public.commande_client_workflow_checkpoint WHERE commande_id=$1",
        [order.id],
      )
    ).rows;
    expect(statuses.filter((r) => r.status === "done")).toHaveLength(
      doneBefore,
    );
    expect(
      statuses.filter((r) =>
        ["active", "blocked", "pending"].includes(r.status),
      ),
    ).toHaveLength(0);
    const list = await repoListCommandes(
      listCommandesQuerySchema.parse({ client_id: client, statut: "ANNULE" }),
    );
    expect(list.items).toEqual([
      expect.objectContaining({ numero: order.numero, statut: "ANNULE" }),
    ]);
  });
});
