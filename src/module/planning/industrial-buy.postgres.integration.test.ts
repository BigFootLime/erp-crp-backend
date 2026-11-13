import { randomUUID } from "node:crypto";
import { createPilotFixtureClient } from "../../__tests__/fixtures/demand-pilot.fixture";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signPilotFixtureSession } from "../../__tests__/fixtures/industrial-pilot-session.fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import pool from "../../config/database";
import industrialRouter from "./routes/industrial-plan.routes";
import supplierOrderRouter from "../commande-fournisseur/routes/commande-fournisseur.routes";
import { HttpError } from "../../utils/httpError";
import { processIndustrialRun } from "./services/industrial-runs.service";
import { authenticateToken } from "../auth/middlewares/auth.middleware";
import { runAuthoritativePdfArchiveWorkerOnce } from "../../shared/authoritative-documents/authoritative-document.worker";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const enabled =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_INDUSTRIAL_BUY_POSTGRES_TEST === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";

// S44 p.1 is the business reference. The date, supplier, ids and price remain
// isolated fixture data. They must never be interpreted as a Vision order.
const visionReference =
  process.env.CERP_VISION_BUY_REFERENCE?.trim() || "VISION-S44-REFERENCE";
const quantity = Number(process.env.CERP_VISION_BUY_QUANTITY ?? "1");
const unique = randomUUID();
let clientId: string;
const pilotArticleCode = `VISION-${visionReference}-${unique.slice(0, 8)}`;
const componentArticleCode = `CMP-${unique.slice(0, 8)}`;
const articleId = randomUUID();
const componentArticleId = randomUUID();
const supplierId = randomUUID();
let actorId: number;
let needDate: string;
let token: string;
let vaultRoot: string;
const calendarId = randomUUID();
let previousCalendar: string | null;
const previousEnv = {
  JWT_SECRET: process.env.JWT_SECRET,
  CERP_GED_VAULT_ROOT: process.env.CERP_GED_VAULT_ROOT,
  CERP_GED_REQUIRE_SENTINEL: process.env.CERP_GED_REQUIRE_SENTINEL,
};

const app = express()
  .use(express.json())
  .use(authenticateToken)
  .use("/planning/industrial", industrialRouter)
  .use("/commandes-fournisseurs", supplierOrderRouter)
  .use(((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const known = error as HttpError & { code?: string };
    res
      .status(known.status ?? 500)
      .json({ code: known.code, message: known.message });
  }) as express.ErrorRequestHandler);

const api = {
  get: (url: string) =>
    request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url: string) =>
    request(app).post(url).set("Authorization", `Bearer ${token}`),
  patch: (url: string) =>
    request(app).patch(url).set("Authorization", `Bearer ${token}`),
};

async function waitForRun(id: string) {
  for (let i = 0; i < 30; i++) {
    await processIndustrialRun();
    const run = await api.get(`/planning/industrial/runs/${id}`);
    if (run.body.status !== "QUEUED" && run.body.status !== "RUNNING")
      return run;
  }
  throw new Error("Industrial run did not complete");
}

async function createValidatedRun(label: string) {
  const created = await api
    .post("/planning/industrial/runs")
    .send({
      client_id: clientId,
      start: needDate.slice(0, 7) + "-01",
      label,
      capacity_percent: 100,
      months: 18,
      weeks: 26,
    })
    .expect(202);
  const ready = await waitForRun(created.body.id);
  expect(ready.body.status).toBe("READY");
  const buyIndex = ready.body.result.proposals.findIndex(
    (proposal: { article: string; kind: string; issues: string[] }) =>
      proposal.article === componentArticleCode &&
      proposal.kind === "BUY" &&
      proposal.issues.length === 0,
  );
  expect(buyIndex).toBeGreaterThanOrEqual(0);
  await api
    .post(`/planning/industrial/runs/${created.body.id}/validate`)
    .send({})
    .expect(200);
  return {
    id: created.body.id as string,
    buyIndex,
    buy: ready.body.result.proposals[buyIndex] as {
      due: string;
      quantity: number;
    },
  };
}

describe.skipIf(!enabled)(
  "Vision pilot BUY proposal through authenticated industrial routes",
  () => {
    beforeAll(async () => {
      previousCalendar = (
        await pool.query(
          "SELECT workshop_calendar_id::text FROM public.planning_central_settings WHERE singleton",
        )
      ).rows[0].workshop_calendar_id;
      await pool.query(
        `INSERT INTO public.programmation_calendars
        (id,code,label,timezone,working_days,day_start,day_end,active)
        VALUES($1,$2,'Calendrier recette achat','Europe/Paris',ARRAY[1,2,3,4,5],'07:00','17:00',true)`,
        [calendarId, "BUY-" + unique.slice(0, 8)],
      );
      await pool.query(
        "UPDATE public.planning_central_settings SET workshop_calendar_id=$1 WHERE singleton",
        [calendarId],
      );
      const actor = (
        await pool.query<{ id: number }>(
          "SELECT id FROM public.users WHERE is_superadmin AND status='Active' ORDER BY id LIMIT 1",
        )
      ).rows[0];
      if (!actor)
        throw new Error("Missing isolated active superadmin fixture.");
      actorId = actor.id;
      process.env.JWT_SECRET = randomUUID() + randomUUID();
      token = (await signPilotFixtureSession(actor.id)).token;
      vaultRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "cerp-vision-buy-vault-"),
      );
      process.env.CERP_GED_VAULT_ROOT = vaultRoot;
      process.env.CERP_GED_REQUIRE_SENTINEL = "false";
      needDate = (
        await pool.query<{ due: string }>(
          "SELECT ((CURRENT_DATE + interval '35 days')::date)::text AS due",
        )
      ).rows[0].due;

      clientId = await createPilotFixtureClient(
        pool,
        "B",
        "Vision Systems fixture isolated",
      );
      const manufactured = await pool.connect();
      let versionId: string;
      try {
        await manufactured.query("BEGIN");
        const pieceId = randomUUID();
        versionId = randomUUID();
        await manufactured.query(
          `INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,code_piece,name_piece,designation)
           VALUES($1::uuid,$1::uuid,1,$2,$2,'Article Vision synthétique de recette')`,
          [pieceId, `VS-${unique.slice(0, 8)}`],
        );
        await manufactured.query(
          `INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,statut,date_application,date_effet)
           VALUES($1::uuid,$2::uuid,'A','BROUILLON',CURRENT_DATE,CURRENT_DATE)`,
          [versionId, pieceId],
        );
        await manufactured.query(
          `INSERT INTO public.articles(id,root_article_id,version_number,plan_index,code,designation,article_type,piece_technique_id,unite,article_category,status,commercial_scope,is_sold,stock_managed,family_code)
           VALUES($1::uuid,$1::uuid,1,1,$2,'Article Vision synthétique de recette','PIECE_TECHNIQUE',$3::uuid,'PCE','fabrique','VALIDE','CLIENTS',true,true,'VISION')`,
          [articleId, pilotArticleCode, pieceId],
        );
        await manufactured.query(
          "INSERT INTO public.article_client_links(article_id,client_id,created_by) VALUES($1::uuid,$2,$3)",
          [articleId, clientId, actorId],
        );
        await manufactured.query(
          "INSERT INTO public.articles_fabrique_families(code,designation) VALUES('VISION','Famille de recette Vision') ON CONFLICT(code) DO NOTHING",
        );
        await manufactured.query(
          "INSERT INTO public.articles_fabrique(article_id,family_code,piece_technique_id) VALUES($1::uuid,'VISION',$2::uuid)",
          [articleId, pieceId],
        );
        await manufactured.query(
          `INSERT INTO public.articles(id,root_article_id,version_number,plan_index,code,designation,article_type,unite,article_category,status,commercial_scope,internal_reference,is_sold,family_code)
           VALUES($1,$1,1,1,$2,'Composant acheté synthétique du pilote Vision','PURCHASED','PCE','achat','VALIDE','CRP',$2,false,'VISION')`,
          [componentArticleId, componentArticleCode],
        );
        await manufactured.query(
          `INSERT INTO public.pieces_techniques_achats(piece_technique_id,piece_technique_version_id,phase,nom,designation,type_achat,article_id,quantite,unite_prix)
           SELECT piece_technique_id,$1::uuid,10,'Composant acheté synthétique','Composant acheté synthétique','COMPOSANT_CATALOGUE',$2::uuid,1,'PCE'
           FROM public.articles WHERE id=$3::uuid`,
          [versionId, componentArticleId, articleId],
        );
        await manufactured.query(
          "UPDATE public.piece_technique_versions SET statut='APPLICABLE' WHERE id=$1::uuid",
          [versionId],
        );
        await manufactured.query("COMMIT");
      } catch (error) {
        await manufactured.query("ROLLBACK");
        throw error;
      } finally {
        manufactured.release();
      }
      await pool.query(
        `INSERT INTO public.commande_client(numero,client_id,code_client,order_type,date_commande,date_livraison_prevue,total_ht,total_ttc,created_by,updated_by)
         VALUES($1,$2::text,$3::text,'FERME',CURRENT_DATE,$4::date,0,0,$5,$5)`,
        [`VISION-FIXTURE-${unique}`, clientId, clientId, needDate, actorId],
      );
      const command = await pool.query<{ id: number }>(
        "SELECT id FROM public.commande_client WHERE numero=$1",
        [`VISION-FIXTURE-${unique}`],
      );
      await pool.query(
        `INSERT INTO public.commande_ligne(commande_id,ordre,designation,code_piece,quantite,unite,delai_client,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,total_ttc,article_id,sale_price_decision,reconciliation_status,reconciliation_sources,reconciliation_decisions)
         VALUES($1,1,$2,$2,$3,'PCE',$4::date,0,0,20,0,0,$5,'KEEP','RESOLVED','{}'::jsonb,'{}'::jsonb)`,
        [command.rows[0].id, visionReference, quantity, needDate, articleId],
      );
      await pool.query(
        `INSERT INTO public.fournisseurs(id,code,code_fournisseur,nom,raison_sociale,actif,status,created_by,updated_by)
         VALUES($1,$2,$2,'Fournisseur isolé achat Vision','Fournisseur isolé achat Vision',true,'actif',$3,$3)`,
        [supplierId, `SUP-${unique.slice(0, 8)}`, actorId],
      );
      await pool.query(
        `INSERT INTO public.industrial_article_rules(article_id,family,lead_days,unit_cost_eur,yield_percent,lot_size,yield_qualified_at)
         VALUES($1,'VISION',5,12.5,100,1,now())`,
        [articleId],
      );
      await pool.query(
        `INSERT INTO public.industrial_article_rules(article_id,family,lead_days,unit_cost_eur,yield_percent,lot_size,yield_qualified_at)
         VALUES($1,'VISION',5,12.5,100,1,now())`,
        [componentArticleId],
      );
    });

    afterAll(async () => {
      await pool.query(
        "UPDATE public.planning_central_settings SET workshop_calendar_id=$1 WHERE singleton AND workshop_calendar_id=$2",
        [previousCalendar, calendarId],
      );
      for (const [key, val] of Object.entries(previousEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
      await pool.end();
    });

    it("creates one priced draft PO, freezes and archives its official PDF locally, then records the controlled send transition", async () => {
      const first = await createValidatedRun("Vision S44 BUY fixture");
      const missingSupplier = await api
        .post(`/planning/industrial/runs/${first.id}/proposals/execute`)
        .send({
          proposal_indexes: [first.buyIndex],
          request_key: `no-supplier-${unique}`,
        })
        .expect(200);
      expect(missingSupplier.body.outcomes).toMatchObject([
        {
          status: "REVIEW",
          reason: expect.stringContaining("Fournisseur non sélectionné"),
        },
      ]);

      const second = await createValidatedRun(
        "Vision S44 BUY selected supplier",
      );
      const executionBody = {
        proposal_indexes: [second.buyIndex],
        request_key: `buy-${unique}`,
        supplier_id: supplierId,
      };
      const [firstPost, duplicatePost] = await Promise.all([
        api
          .post(`/planning/industrial/runs/${second.id}/proposals/execute`)
          .send(executionBody),
        api
          .post(`/planning/industrial/runs/${second.id}/proposals/execute`)
          .send(executionBody),
      ]);
      expect(firstPost.status).toBe(200);
      expect(duplicatePost.status).toBe(200);
      const executed = firstPost.body.replayed ? duplicatePost : firstPost;
      expect(firstPost.body.replayed || duplicatePost.body.replayed).toBe(true);
      expect(executed.body.outcomes).toMatchObject([
        { status: "EXECUTED", target_type: "COMMANDE_FOURNISSEUR" },
      ]);
      const orderId = executed.body.outcomes[0].target_id as string;
      const order = await pool.query<{
        statut: string;
        origine: string;
        date_besoin: string;
        quantite: string;
        line_id: string;
        prix_unitaire_ht: string;
        note_interne: string;
      }>(
        `SELECT po.statut,po.origine,po.date_besoin::text,line.id::text AS line_id,line.quantite::text,line.prix_unitaire_ht::text,po.note_interne
         FROM public.commande_fournisseur po
         JOIN public.commande_fournisseur_ligne line ON line.commande_id=po.id
         WHERE po.id=$1::uuid`,
        [orderId],
      );
      expect(order.rows).toEqual([
        expect.objectContaining({
          statut: "BROUILLON",
          origine: "PROPOSITION_MRP",
          date_besoin: second.buy.due,
          quantite: second.buy.quantity.toFixed(3),
          note_interne: expect.stringContaining(
            "prix et promesse fournisseur à confirmer",
          ),
        }),
      ]);

      const replay = await api
        .post(`/planning/industrial/runs/${second.id}/proposals/execute`)
        .send(executionBody)
        .expect(200);
      expect(replay.body.replayed).toBe(true);
      expect(
        await pool.query(
          "SELECT 1 FROM public.commande_fournisseur WHERE id=$1::uuid",
          [orderId],
        ),
      ).toMatchObject({ rowCount: 1 });

      await api
        .patch(
          `/commandes-fournisseurs/${orderId}/lignes/${order.rows[0].line_id}`,
        )
        .send({ patch: { prix_unitaire_ht: 12.5 } })
        .expect(204);
      expect(
        (
          await pool.query(
            "SELECT prix_unitaire_ht::text FROM public.commande_fournisseur_ligne WHERE id=$1::uuid",
            [order.rows[0].line_id],
          )
        ).rows[0].prix_unitaire_ht,
      ).toBe("12.5000");

      const submit = await api
        .post(`/commandes-fournisseurs/${orderId}/transition`)
        .send({ to: "A_VALIDER", idempotency_key: `submit-${unique}` });
      expect(submit).toMatchObject({
        status: 200,
        body: { statut: "A_VALIDER" },
      });
      const approved = await api
        .post(`/commandes-fournisseurs/${orderId}/transition`)
        .send({ to: "APPROUVEE", idempotency_key: `approve-${unique}` })
        .expect(200);
      expect(approved.body).toMatchObject({ statut: "APPROUVEE" });

      const frozen = await api
        .post(`/commandes-fournisseurs/${orderId}/documents`)
        .send({})
        .expect(201);
      expect(frozen.body).toHaveProperty("version", 1);
      const queued = await api
        .get(`/commandes-fournisseurs/${orderId}/official-documents`)
        .expect(200);
      expect(queued.body.state).toBe("PENDING");
      // Each worker batch can contain documents from earlier OFs or delivery affairs.
      let issued = queued;
      for (let batch = 0; batch < 30 && issued.body.state === "PENDING"; batch++) {
        if (await runAuthoritativePdfArchiveWorkerOnce() === 0) break;
        issued = await api.get(`/commandes-fournisseurs/${orderId}/official-documents`).expect(200);
      }
      expect(issued.body).toMatchObject({
        state: "READY",
        latest_document: { state: "ISSUED" },
      });
      const documentId = issued.body.latest_document.id as string;
      const preview = await api
        .get(
          `/commandes-fournisseurs/${orderId}/official-documents/${documentId}/preview`,
        )
        .expect(200);
      expect(Buffer.isBuffer(preview.body)).toBe(true);
      expect(preview.body.subarray(0, 5).toString("ascii")).toBe("%PDF-");

      const send = await api
        .post(`/commandes-fournisseurs/${orderId}/transition`)
        .send({ to: "ENVOYEE", idempotency_key: `send-${unique}` })
        .expect(200);
      expect(send.body).toMatchObject({ statut: "ENVOYEE" });
      expect(
        (
          await pool.query(
            "SELECT statut FROM public.commande_fournisseur WHERE id=$1::uuid",
            [orderId],
          )
        ).rows[0].statut,
      ).toBe("ENVOYEE");
    });

    it("does not create another draft when the same unresolved firm need is planned again", async () => {
      const repeat = await createValidatedRun("Vision S44 BUY duplicate guard");
      const response = await api
        .post(`/planning/industrial/runs/${repeat.id}/proposals/execute`)
        .send({
          proposal_indexes: [repeat.buyIndex],
          request_key: `repeat-${unique}`,
          supplier_id: supplierId,
        })
        .expect(200);
      expect(response.body.outcomes).toMatchObject([{ status: "REVIEW" }]);
      expect(
        await pool.query(
          "SELECT count(*)::int AS count FROM public.commande_fournisseur WHERE origine='PROPOSITION_MRP' AND fournisseur_id=$1::uuid",
          [supplierId],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
    });
    it("retains an overdue firm schedule for review without opening another purchase", async () => {
      const requested =
        process.env.CERP_VISION_OVERDUE_DATE ||
        (await pool.query("SELECT (CURRENT_DATE - 7)::text AS day")).rows[0]
          .day;
      const added = await pool.query(
        `INSERT INTO public.commande_ligne
        (commande_id,ordre,designation,code_piece,quantite,unite,delai_client,prix_unitaire_ht,remise_ligne,taux_tva,
          total_ht,total_ttc,article_id,sale_price_decision,reconciliation_status,reconciliation_sources,reconciliation_decisions)
        SELECT l.commande_id,2,l.designation,l.code_piece,l.quantite,l.unite,$2::date,l.prix_unitaire_ht,l.remise_ligne,l.taux_tva,
          l.total_ht,l.total_ttc,l.article_id,l.sale_price_decision,l.reconciliation_status,l.reconciliation_sources,l.reconciliation_decisions
        FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id
        WHERE c.numero=$1 AND l.ordre=1 RETURNING id::text,delai_client::text`,
        [`VISION-FIXTURE-${unique}`, requested],
      );
      expect(added.rows[0].delai_client).toBe(requested);
      const today = (await pool.query("SELECT current_date::text AS day"))
        .rows[0].day;
      const run = await api
        .post("/planning/industrial/runs")
        .send({
          client_id: clientId,
          start: today,
          label: "Vision RAL échu",
          months: 18,
          weeks: 26,
        })
        .expect(202);
      await processIndustrialRun();
      const read = await api
        .get(`/planning/industrial/runs/${run.body.id}`)
        .expect(200);
      type P = {
        kind: string;
        article_id: string;
        source_ids: string[];
        issues: string[];
      };
      const proposals: P[] = read.body.result.proposals;
      const i = proposals.findIndex(
        (p) =>
          p.kind === "BUY" &&
          p.article_id === componentArticleId &&
          p.source_ids.includes("firm:" + added.rows[0].id + "::default"),
      );
      expect(i).toBeGreaterThanOrEqual(0);
      expect(proposals[i].issues).toContain(
        "Lancement en zone protégée ou en retard.",
      );
      await api
        .post(`/planning/industrial/runs/${run.body.id}/validate`)
        .send({})
        .expect(200);
      const decision = await api
        .post(`/planning/industrial/runs/${run.body.id}/proposals/execute`)
        .send({
          proposal_indexes: [i],
          supplier_id: supplierId,
          request_key: `overdue-${unique}`,
        })
        .expect(200);
      expect(decision.body.outcomes).toMatchObject([{ status: "REVIEW" }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM public.commande_fournisseur WHERE fournisseur_id=$1",
            [supplierId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  },
);
