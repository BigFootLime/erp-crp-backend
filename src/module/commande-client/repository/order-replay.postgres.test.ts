import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import {
  createPilotFixtureClient,
  createPilotFixtureArticle,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
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
describe.skipIf(!isolated)("Guided order retries and cancellation", () => {
  afterAll(async () => {
    await pool.end();
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
