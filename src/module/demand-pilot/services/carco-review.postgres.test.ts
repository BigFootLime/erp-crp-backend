import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import {
  createPilotFixtureClient,
  createPilotFixtureArticle,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import { saveArticleMapping } from "../repository/demand-mapping.repository";
import { exportCarco } from "./carco-return";
import {
  recordCarco,
  getCarco,
  bindCarco,
  submitCarco,
} from "./carco-review.service";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";
const prefix = randomUUID().slice(0, 8);
const scope = { clientId: "", site: "CARCO-" + prefix };
const dates = [
  "2030-01-02T09:00:00Z",
  "2030-01-09T09:00:00Z",
  "2030-01-16T09:00:00Z",
];
const a = "EXT-" + prefix;
function file(lines: string[]) {
  const buffer = Buffer.from(
    [
      "NUM_CDE;NUM_LIGNE_CDE;ARTICLE;TYPE_CDE;DATE_BESOIN;QTE_SOLDE;QTE_LIV;ID_ECHEANCE;UNITE",
      ...lines,
    ].join("\n"),
  );
  return {
    originalname: "sample.csv",
    buffer,
    size: buffer.length,
    mimetype: "text/csv",
  } as Express.Multer.File;
}
describe.skipIf(!isolated)(
  "CLAYENS weekly review on isolated PostgreSQL",
  () => {
    let actor: number;
    const article = randomUUID();
    beforeAll(async () => {
      actor = (
        await pool.query(
          "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
        )
      ).rows[0].id;
      await industrialTx(async (tx) => {
        scope.clientId = await createPilotFixtureClient(
          tx,
          "K",
          "Client de recette",
        );
        await createPilotFixtureArticle(
          tx,
          scope.clientId,
          actor,
          article,
          "CRP-" + prefix,
        );
        await saveArticleMapping(
          tx,
          {
            client_id: scope.clientId,
            external_code: a,
            external_unit: "PCE",
            article_id: article,
            units_per_external: 1,
          },
          actor,
        );
      });
    });
    afterAll(async () => {
      await pool.end();
    });
    it("queues a Clayens advancement for ADV and preserves the acknowledged date", async () => {
      const arScope = { ...scope, site: scope.site + "-AR" };
      const { rows: [promise] } = await pool.query<{ id: string }>(
        `WITH c AS (
          INSERT INTO public.commande_client(numero,client_id) VALUES($1,$2) RETURNING id
        ), l AS (
          INSERT INTO public.commande_ligne(commande_id,article_id,quantite)
          SELECT id,$3,7 FROM c RETURNING id,commande_id
        ), f AS (
          INSERT INTO public.affaire(commande_id,nom)
          SELECT id,'Livraison fixture AR' FROM c RETURNING id,commande_id
        ), a AS (
          INSERT INTO public.commande_ligne_affaire_allocation(commande_id,commande_ligne_id,livraison_affaire_id,qty_ordered,qty_remaining)
          SELECT l.commande_id,l.id,f.id,7,7 FROM l JOIN f USING(commande_id) RETURNING *
        ), d AS (
          INSERT INTO public.documents_clients(document_name) VALUES('AR fixture') RETURNING id
        ), ar AS (
          INSERT INTO public.commande_ar_log(commande_id,document_id,status,sent_at,ar_series_number,version_number,ar_reference)
          SELECT c.id,d.id,'SENT',now(),c.id,1,$1 FROM c,d RETURNING id,commande_id
        ), r AS (
          INSERT INTO public.delivery_promise_roots(allocation_id,commande_id,line_id,affaire_id,ar_id,initial_quantity,initial_due_date,initial_snapshot)
          SELECT a.id,a.commande_id,a.commande_ligne_id,a.livraison_affaire_id,ar.id,7,'2030-05-17','{}'
          FROM a JOIN ar USING(commande_id) RETURNING id
        ), p AS (
          INSERT INTO public.delivery_promise_parts(root_id,quantity,due_date)
          SELECT id,7,'2030-05-17' FROM r
        ), b AS (
          INSERT INTO public.demand_pilot_firm_binding_scopes(client_id,external_site,external_order_key,external_line_key,external_schedule_key,promise_root_id,article_id,created_by_user_id)
          SELECT $2,$4,$1,'L10','E1',id,$3,$5 FROM r
        ) SELECT id FROM r`,
        ["CMD-AR-" + prefix, scope.clientId, article, arScope.site, actor],
      );
      const csv = Buffer.from([
        "LIEU_EXP_FO;ARTICLE;NUM_CDE;TYPE_CDE;DATE_CDE;DATE_DEMANDEE;DATE_CONF;QTE_CDE;QTE_LIV;QTE_SOLDE;DATE_BESOIN",
        `SITE;${a};CMD-AR-${prefix};Cde Fermée;02/01/2030;18/05/2030;19/05/2030;10;3;7;03/05/2030`,
        `SITE;${a};CMD-SANS-AR;Cde Fermee;02/01/2030;18/05/2030;;7;0;7;31/12/9000`,
      ].join("\n"));
      const id = await recordCarco(arScope, "AR-1", dates[0], true, {
        ...file([]), buffer: csv, size: csv.length,
      }, actor);
      const review = (await getCarco(arScope, id))!;
      expect(review).toMatchObject({ format: "CLAYENS_AR", complete: false, summary: { total: 2, valid: 1, invalid: 1 } });
      expect(review.ready[0]).toMatchObject({
        external_line_key: "L10", external_schedule_key: "E1", quantity: 7,
        source_requested_date: "2030-05-18", source_confirmed_date: "2030-05-19", need_date: "2030-05-03",
      });
      expect(review.lines[1].diagnostics.map(({ code }) => code)).toEqual(
        expect.arrayContaining(["CLAYENS_AR_NO_BINDING", "SENTINEL_DATE_REQUIRES_REVIEW"]),
      );
      expect(await submitCarco(arScope, id, actor, randomUUID(), review.qualification_hash)).toMatchObject({ created: 1, missing: 0 });
      expect((await pool.query(
        `SELECT status,need_date::text FROM public.demand_pilot_revisions WHERE client_id=$1 AND external_site=$2`,
        [scope.clientId, arScope.site],
      )).rows).toEqual([{ status: "REVIEW", need_date: "2030-05-03" }]);
      expect((await pool.query("SELECT due_date::text FROM public.delivery_promise_parts WHERE root_id=$1", [promise.id])).rows)
        .toEqual([{ due_date: "2030-05-17" }]);
      expect(await exportCarco(arScope, id)).toContain('"2030-05-18";"2030-05-17";"AR_ENGAGE"');
    });
    it("keeps ambiguous lines, compares successive versions, submits only the RAL and replays without duplicates", async () => {
      const lines = [
        `ORDER;1;${a};Cde Fermee;12/02/2030;46;4;;`,
        `ORDER;2;${a};Cde Fermee;20/02/2030;5;0;S-2;`,
        "OPEN;3;UNKNOWN;Cde ouverte;15/02/2030;8;0;;",
        "OPEN;3;UNKNOWN;Cde ouverte;15/02/2030;8;0;;",
      ];
      const f = file(lines),
        id = await recordCarco(scope, "W1", dates[0], true, f, actor);
      expect(await recordCarco(scope, "W1", dates[0], true, f, actor)).toBe(id);
      let review = (await getCarco(scope, id))!;
      expect(review.summary).toMatchObject({ total: 4, valid: 1, invalid: 3 });
      expect(
        review.differences.find((d) => d.status === "AMBIGUOUS")?.after,
      ).toHaveLength(2);
      expect(review.lines[2].diagnostics.map((d) => d.code)).toContain(
        "CARCO_ARTICLE_UNKNOWN",
      );
      expect(await submitCarco(scope, id, actor, randomUUID())).toMatchObject({
        created: 1,
        missing: 0,
      });
      await bindCarco(scope, id, 2, "STABLE-1", actor);
      await expect(bindCarco(scope, id, 4, "NO", actor)).rejects.toMatchObject({
        code: "CARCO_BIND_AMBIGUOUS",
      });
      review = (await getCarco(scope, id))!;
      expect(
        review.ready.find((r) => r.external_line_key === "1"),
      ).toMatchObject({
        quantity: 46,
        source_delivered_quantity: 4,
        quantity_basis: "REMAINING",
      });
      expect(await submitCarco(scope, id, actor, randomUUID())).toMatchObject({
        created: 2,
      });
      await submitCarco(scope, id, actor, randomUUID());
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM public.demand_pilot_revisions WHERE client_id=$1 AND external_site=$2",
            [scope.clientId, scope.site],
          )
        ).rows[0].n,
      ).toBe(2);
      const newFile = file([
        lines[0].replace("12/02/2030;46;4", "10/02/2030;40;10"),
      ]);
      const next = await recordCarco(
        scope,
        "W2",
        dates[1],
        false,
        newFile,
        actor,
      );
      const delta = (await getCarco(scope, next))!;
      expect(
        delta.differences.find((d) => d.status === "CHANGED")?.changes,
      ).toEqual(
        expect.arrayContaining([
          "quantity",
          "need_date",
          "source_delivered_quantity",
        ]),
      );
      expect(delta.differences.some((d) => d.status === "OUT_OF_SCOPE")).toBe(
        true,
      );
      await expect(
        submitCarco(scope, id, actor, randomUUID()),
      ).rejects.toMatchObject({ code: "CARCO_NOT_READY" });
      await expect(
        recordCarco(scope, "OLD", dates[0], true, f, actor),
      ).rejects.toMatchObject({ code: "CARCO_STALE" });
      expect(await submitCarco(scope, next, actor, randomUUID())).toMatchObject(
        { created: 1, missing: 0 },
      );
      const complete = await recordCarco(
        scope,
        "W3",
        dates[2],
        true,
        newFile,
        actor,
      );
      expect(
        await submitCarco(scope, complete, actor, randomUUID()),
      ).toMatchObject({ created: 0, unchanged: 1, missing: 1 });
      expect(
        (
          await pool.query(
            "SELECT status FROM public.demand_pilot_revisions WHERE client_id=$1 AND diff_type='REMOVED'",
            [scope.clientId],
          )
        ).rows,
      ).toEqual([{ status: "REVIEW" }]);
      const same = await recordCarco(
        scope,
        "W4",
        "2030-01-23T09:00:00Z",
        true,
        newFile,
        actor,
      );
      const repeated = (await getCarco(scope, same))!;
      expect(repeated.differences.every((d) => d.status === "UNCHANGED")).toBe(
        true,
      );
      await expect(
        submitCarco(scope, same, actor, randomUUID(), "invalidated-preview"),
      ).rejects.toMatchObject({ code: "CARCO_REVIEW_CHANGED" });
      expect(
        await submitCarco(
          scope,
          same,
          actor,
          randomUUID(),
          repeated.qualification_hash,
        ),
      ).toMatchObject({ created: 0, missing: 0 });
      await expect(
        recordCarco(
          scope,
          "OUT-OF-ORDER",
          "2030-01-18T09:00:00Z",
          true,
          f,
          actor,
        ),
      ).rejects.toMatchObject({ code: "CARCO_STALE" });
      const split = await recordCarco(
        scope,
        "W5",
        "2030-01-30T09:00:00Z",
        false,
        file([lines[0], lines[0]]),
        actor,
      );
      expect((await getCarco(scope, split))!.summary.valid).toBe(0);
      const collapsed = await recordCarco(
        scope,
        "W6",
        "2030-02-06T09:00:00Z",
        false,
        file([lines[0]]),
        actor,
      );
      const single = (await getCarco(scope, collapsed))!;
      expect(single.lines[0].diagnostics.map((d) => d.code)).toContain(
        "CARCO_PREVIOUS_SPLIT",
      );
      expect(single.summary.valid).toBe(0);
    });
  },
);
