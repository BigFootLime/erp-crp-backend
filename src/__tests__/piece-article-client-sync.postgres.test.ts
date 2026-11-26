import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../config/database";
import { errorHandler } from "../middlewares/errorHandler";
import { updatePieceTechnique } from "../module/pieces-techniques/controllers/pieces-techniques.controller";
import { getStockArticle, updateStockArticle } from "../module/stock/controllers/stock.controller";
import { createPilotFixtureArticle, createPilotFixtureClient } from "./fixtures/demand-pilot.fixture";

const fixturePort = process.env.CERP_PT_ARTICLE_FIXTURE_PORT;
const enabled = process.env.CERP_E2E_ISOLATED === "1"
  && /^\d+$/.test(fixturePort ?? "")
  && process.env.DATABASE_URL === `postgresql://postgres@127.0.0.1:${fixturePort}/cerp_test`;

describe.skipIf(!enabled)("Technical-piece client changes on PostgreSQL", () => {
  const app = express();
  let actorId: number;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: actorId, role: "Operateur" } as typeof req.user;
    next();
  });
  app.patch("/api/v1/pieces-techniques/:id", updatePieceTechnique);
  app.get("/api/v1/stock/articles/:id", getStockArticle);
  app.patch("/api/v1/stock/articles/:id", updateStockArticle);
  app.use(errorHandler);

  beforeAll(async () => {
    const identity = (await db.query(
      `SELECT current_database() AS database, current_user AS role, current_setting('cluster_name') AS cluster`,
    )).rows[0];
    expect(identity).toEqual({ database: "cerp_test", role: "postgres", cluster: "cerp-pt-client-article-fixture" });
    actorId = Number((await db.query("SELECT id FROM public.users ORDER BY id LIMIT 1")).rows[0]?.id);
    expect(actorId).toBeGreaterThan(0);
  });

  afterAll(async () => { await db.end(); });

  async function seed({ divergent = false, secondary = false } = {}) {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const original = await createPilotFixtureClient(tx, "K", "Client principal initial de recette");
      const next = await createPilotFixtureClient(tx, "K", "Nouveau client principal de recette");
      const extra = secondary ? await createPilotFixtureClient(tx, "K", "Client secondaire de recette") : null;
      const article = randomUUID();
      const code = `FIXTURE-CLIENT-${randomUUID()}`;
      const { piece, version } = await createPilotFixtureArticle(tx, original, actorId, article, code, { publish: false });
      const primary = divergent ? next : original;
      const { updated_at: expected } = (await tx.query<{ updated_at: string }>(
        `UPDATE public.pieces_techniques SET client_id=$2, article_id=$3::uuid, commercial_scope='CLIENTS'
          WHERE id=$1::uuid RETURNING updated_at::text`, [piece, primary, article],
      )).rows[0];
      if (extra) await tx.query(`INSERT INTO public.article_client_links(article_id, client_id, created_by) VALUES ($1, $2, $3)`, [article, extra, actorId]);
      await tx.query("COMMIT");
      return { original, next, extra, article, code, piece, version, expected };
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }

  const getArticle = (id: string) => request(app).get(`/api/v1/stock/articles/${id}`);
  const patchPiece = (id: string, client_id: string | null, expected_updated_at: string) =>
    request(app).patch(`/api/v1/pieces-techniques/${id}`).send({ client_id, expected_updated_at });

  it("moves the primary relation while preserving other clients and immutable records", async () => {
    const { original, next, extra, article, code, piece, version, expected } = await seed({ secondary: true });
    const before = await getArticle(article).expect(200);
    expect(before.body).toMatchObject({ client_code: original, client_ids: [original, extra].sort(), code });
    const versionBefore = (await db.query(`SELECT to_jsonb(v) AS data FROM public.piece_technique_versions v WHERE id=$1`, [version])).rows[0];

    const updated = await patchPiece(piece, next, expected).expect(200);
    expect(updated.body).toMatchObject({ id: piece, client_id: next, code_piece: code });

    const after = await getArticle(article).expect(200);
    expect(after.body).toMatchObject({ id: article, code, client_code: next, client_ids: [next, extra].sort(), row_version: before.body.row_version + 1 });
    expect(after.body.associated_clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: next, code: next }), expect.objectContaining({ id: extra }),
    ]));
    expect(after.body.associated_clients).toHaveLength(2);
    expect((await db.query(`SELECT to_jsonb(v) AS data FROM public.piece_technique_versions v WHERE id=$1`, [version])).rows[0]).toEqual(versionBefore);

    await request(app).patch(`/api/v1/stock/articles/${article}`)
      .send({ expected_row_version: before.body.row_version, designation: "Modification Stock périmée" }).expect(409);
    await patchPiece(piece, original, expected).expect(409);
    expect((await getArticle(article).expect(200)).body.client_ids).toEqual(after.body.client_ids);
  });

  it("qualifies a previously missed primary link without guessing about existing clients", async () => {
    const { original, next, article, code, piece, expected } = await seed({ divergent: true });
    const before = await getArticle(article).expect(200);
    expect(before.body).toMatchObject({ client_code: next, client_ids: [original], code });

    const updated = await patchPiece(piece, next, expected).expect(200);
    const after = await getArticle(article).expect(200);
    expect(after.body).toMatchObject({ client_code: next, client_ids: [original, next].sort(), code, row_version: before.body.row_version + 1 });

    await patchPiece(piece, next, updated.body.updated_at).expect(200);
    expect((await getArticle(article).expect(200)).body.row_version).toBe(after.body.row_version);
  });

  it("preserves existing article authorizations when the technical client is cleared", async () => {
    const { original, extra, article, code, piece, expected } = await seed({ secondary: true });
    const before = await getArticle(article).expect(200);
    const cleared = await patchPiece(piece, null, expected).expect(200);
    expect(cleared.body.client_id).toBeNull();
    const after = await getArticle(article).expect(200);
    expect(after.body).toMatchObject({ code, commercial_scope: "CLIENTS", client_ids: [original, extra].sort(),
      row_version: before.body.row_version });
  });
});
