import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import {
  createPilotFixtureClient,
  createPilotFixtureArticle,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import { saveArticleMapping } from "../repository/demand-mapping.repository";
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
        const article = randomUUID();
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
            "SELECT count(*)::int n FROM public.demand_pilot_revisions WHERE client_id=$1",
            [scope.clientId],
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
