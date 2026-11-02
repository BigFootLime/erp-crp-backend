import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import {
  createPilotFixtureArticle,
  createPilotFixtureClient,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
import { importDemand } from "../../demand-pilot/repository/demand-ingest.repository";
import { saveArticleMapping } from "../../demand-pilot/repository/demand-mapping.repository";
import { prepareFirmDraft } from "../../demand-pilot/services/demand-pilot-firm-draft.service";
import { readClientContractCoverageTx } from "../../client/services/client-contract-coverage.service";
import { prepareClientReplenishment } from "../../client/services/client-contract-replenishment.service";
import {
  enqueueIndustrialRun,
  industrialRunById,
  industrialTx,
  processIndustrialRun,
  validateIndustrialRun,
} from "../services/industrial-runs.service";
import { executeIndustrialProposals } from "../services/industrial-proposal-execution.service";
import type { AuditContext } from "../repository/planning.repository";
import type { IndustrialProposal } from "../types/industrial-plan.types";

const databaseUrl = new URL(
  process.env.DATABASE_URL ?? "postgres://localhost/no_database",
);
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname) &&
  databaseUrl.pathname === "/cerp_test";

/*
 * A local runner may set these values from a reviewed Vision programme. They
 * remain synthetic by default, so no customer document or production article
 * is committed to the repository.
 */
const visionArticleCode =
  process.env.CERP_VISION_PILOT_ARTICLE_CODE ?? "VISION-MAKE-SYNTHETIC";
const visionContractReference =
  process.env.CERP_VISION_PILOT_CONTRACT_REFERENCE ??
  "VISION-CONTRACT-SYNTHETIC";
const visionQuantity = Number(process.env.CERP_VISION_PILOT_QUANTITY ?? "1");
let client: string;
const article = randomUUID();
const suffix = randomUUID().slice(0, 8);
const internalArticleCode = "SYN-" + suffix;
const site = "VS-" + suffix;
const order = "VS-OF-" + suffix;
let actor = 0;
let due = "";
let contractValidFrom = "";
let contractValidUntil = "";
let expectedContractTarget = "";
let revisionId = "";
let previousActivation = "";
let previousWorkshopCalendarId: string | null = null;
let contractId = "";
let contractLineId = "";
const audit = (role = "Directeur"): AuditContext => ({
  user_id: actor,
  role,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/planning/industrial",
  page_key: "planning.industrial",
  client_session_id: null,
});

async function processRun(runId: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await industrialRunById(runId);
    if (current.status !== "QUEUED") return current;
    await processIndustrialRun();
  }
  return industrialRunById(runId);
}
function contractWindow(needDate: string) {
  const year = Number(needDate.slice(0, 4));
  const month = Number(needDate.slice(5, 7));
  return {
    validFrom: String(year - 1) + "-01-01",
    validUntil: String(year + 1) + "-12-31",
    target: new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10),
  };
}

describe.skipIf(!isolated)(
  "Vision Systems style firm demand to prepared OF on isolated PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!(visionQuantity > 0) || !Number.isFinite(visionQuantity))
        throw new Error("CERP_VISION_PILOT_QUANTITY must be positive.");
      actor = Number(
        (
          await pool.query(
            "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
          )
        ).rows[0].id,
      );
      due = (
        await pool.query<{ due: string }>(
          "SELECT (CURRENT_DATE + 28)::text AS due",
        )
      ).rows[0].due;
      ({
        validFrom: contractValidFrom,
        validUntil: contractValidUntil,
        target: expectedContractTarget,
      } = contractWindow(due));
      const planningBefore = (
        await pool.query<{
          activation: string;
          workshop_calendar_id: string | null;
        }>(
          "SELECT activation,workshop_calendar_id::text FROM public.planning_central_settings WHERE singleton",
        )
      ).rows[0];
      previousActivation = planningBefore.activation;
      previousWorkshopCalendarId = planningBefore.workshop_calendar_id;
      await industrialTx(async (tx) => {
        client = await createPilotFixtureClient(
          tx,
          "C",
          "Vision Systems fixture isolée",
        );
        const technical = await createPilotFixtureArticle(
          tx,
          client,
          actor,
          article,
          internalArticleCode,
        );
        await saveArticleMapping(
          tx,
          {
            client_id: client,
            article_id: article,
            external_code: visionArticleCode,
            external_unit: "PCE",
            units_per_external: 1,
          },
          actor,
        );
        const unitId = (
          await tx.query<{ id: string }>(
            "SELECT id::text FROM public.units WHERE code='u'",
          )
        ).rows[0].id;
        contractId = randomUUID();
        contractLineId = randomUUID();
        await tx.query(
          `INSERT INTO public.client_contracts(id,client_id,reference,title,valid_from,valid_until,status,created_by,updated_by)
           VALUES($1::uuid,$2,$3,'Contrat ouvert Vision isolé',$4::date,$5::date,'ACTIVE',$6,$6)`,
          [
            contractId,
            client,
            visionContractReference,
            contractValidFrom,
            contractValidUntil,
            actor,
          ],
        );
        await tx.query(
          `INSERT INTO public.client_contract_lines(id,contract_id,article_id,root_article_id,replenishment_qty,unit_id,
            configured_code,configured_designation,configured_indice,configured_piece_technique_version_id)
           VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4::uuid,$5,'Pièce Vision isolée','A',$6::uuid)`,
          [
            contractLineId,
            contractId,
            article,
            unitId,
            visionArticleCode,
            technical.version,
          ],
        );
        await tx.query(
          "UPDATE public.pieces_techniques SET article_id=$2::uuid WHERE id=$1::uuid",
          [technical.piece, article],
        );
        const calendar = randomUUID();
        const machine = randomUUID();
        const gamme = randomUUID();
        await tx.query(
          "INSERT INTO public.programmation_calendars(id,code,label,timezone,working_days,day_start,day_end,active) VALUES($1,$2,'Calendrier Vision isolé','Europe/Paris',ARRAY[1,2,3,4,5],'06:00','22:00',true)",
          [calendar, "VS-CAL-" + suffix],
        );
        await tx.query(
          "UPDATE public.planning_central_settings SET activation='COMMIT',workshop_calendar_id=$1 WHERE singleton",
          [calendar],
        );
        await tx.query(
          "INSERT INTO public.production_machine_families(code,libelle) VALUES('VSM','Famille machine Vision isolée') ON CONFLICT(code) DO NOTHING",
        );
        await tx.query(
          "INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by) VALUES($1,$2,'Machine Vision isolée','MILLING','ACTIVE',true,'VSM',$3,$3)",
          [machine, "VS-M-" + suffix, actor],
        );
        await tx.query(
          "INSERT INTO public.planning_resource_calendars(resource_id,machine_id,calendar_id) VALUES($1,$2,$3)",
          ["machine:" + machine, machine, calendar],
        );
        await tx.query(
          "INSERT INTO public.gammes(id,piece_technique_version_id,code,designation,statut,is_current,created_by,updated_by) VALUES($1,$2,$3,'Gamme Vision isolée','APPLICABLE',true,$4,$4)",
          [gamme, technical.version, "VS-G-" + suffix, actor],
        );
        await tx.query(
          "INSERT INTO public.pieces_techniques_operations(piece_technique_id,gamme_id,phase,ordre,designation,type_operation,machine_id,machine_family_code,coef,tp,tf_unit,qte,temps_fabrication,temps_total) VALUES($1,$2,10,10,'Usinage Vision isolé','FRAISAGE',$3,'VSM',1,0.01,0.001,1,0.001,0.011)",
          [technical.piece, gamme, machine],
        );
        await tx.query(
          "INSERT INTO public.industrial_article_rules(article_id,family,lead_days,unit_cost_eur,yield_percent,lot_size) VALUES($1,'Vision Systems',2,1,100,1)",
          [article],
        );
      });
      const imported = await importDemand({
        clientId: client,
        completeSnapshot: false,
        idempotencyKey: randomUUID(),
        actor: { userId: actor },
        rows: [
          {
            external_site: site,
            external_order_key: order,
            external_line_key: "10",
            external_schedule_key: "S1",
            source_version: "W44",
            source_as_of: new Date().toISOString(),
            kind: "FIRM",
            quantity: visionQuantity,
            unit: "PCE",
            quantity_basis: "REMAINING",
            need_date: due,
            article_code: visionArticleCode,
            contract_reference: visionContractReference,
          },
        ],
      });
      const revision = (
        await pool.query<{ id: string }>(
          "SELECT id::text FROM public.demand_pilot_revisions WHERE import_id=$1::uuid",
          [imported.import_id],
        )
      ).rows[0];
      revisionId = revision.id;
      await prepareFirmDraft(
        {
          client_id: client,
          revision_ids: [revision.id],
          lines: [
            {
              revision_id: revision.id,
              designation: visionArticleCode + " · " + visionContractReference,
              prix_unitaire_ht: 1,
              taux_tva: 20,
              remise_ligne: 0,
            },
          ],
        },
        actor,
        randomUUID(),
      );
      expect(
        (
          await pool.query<{
            contract_id: string | null;
            contract_line_id: string | null;
          }>(
            "SELECT contract_id::text,contract_line_id::text FROM public.demand_pilot_revisions WHERE id=$1::uuid",
            [revision.id],
          )
        ).rows[0],
      ).toEqual({ contract_id: contractId, contract_line_id: contractLineId });
    });

    afterAll(async () => {
      if (previousActivation)
        await pool.query(
          "UPDATE public.planning_central_settings SET activation=$1,workshop_calendar_id=$2::uuid WHERE singleton",
          [previousActivation, previousWorkshopCalendarId],
        );
      await pool.end();
    });

    it("keeps a firm contract demand in REVIEW when its weekly PDP proposal has no exactly matching monthly contract preparation", async () => {
      const start = (
        await pool.query<{ today: string }>(
          "SELECT CURRENT_DATE::text AS today",
        )
      ).rows[0].today;
      const queued = await enqueueIndustrialRun(
        {
          client_id: client,
          start,
          label: "Vision Systems OF end-to-end",
          capacity_percent: 100,
          months: 18,
          weeks: 26,
        },
        actor,
      );
      const ready = await processRun(queued.id);
      expect(ready.status).toBe("READY");
      const proposalIndex = ready.result.proposals.findIndex(
        (proposal: IndustrialProposal) =>
          proposal.kind === "MAKE" &&
          proposal.article_id === article &&
          proposal.quantity === visionQuantity &&
          proposal.due === due,
      );
      expect(proposalIndex).toBeGreaterThanOrEqual(0);
      expect(ready.result.proposals[proposalIndex].contract_line_id).toBe(
        contractLineId,
      );
      expect(ready.result.placements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            article_id: article,
            requested: due,
            status: "CAPACITY_SIMULATED",
          }),
        ]),
      );
      await expect(
        validateIndustrialRun(queued.id, actor),
      ).resolves.toMatchObject({
        status: "VALIDATED",
      });
      await expect(
        executeIndustrialProposals(
          queued.id,
          { proposal_indexes: [proposalIndex], request_key: randomUUID() },
          audit("Commercial"),
        ),
      ).rejects.toMatchObject({ code: "INDUSTRIAL_MAKE_FORBIDDEN" });
      const requestKey = randomUUID();
      const executed = await executeIndustrialProposals(
        queued.id,
        { proposal_indexes: [proposalIndex], request_key: requestKey },
        audit(),
      );
      expect(executed).toMatchObject({
        outcomes: [
          expect.objectContaining({
            proposal_index: proposalIndex,
            status: "REVIEW",
            reason:
              "Aucune préparation contractuelle courante : préparez le réapprovisionnement.",
          }),
        ],
      });
      expect(
        (
          await pool.query<{ delai_client: string }>(
            "SELECT line.delai_client::text FROM public.demand_pilot_firm_draft_lines draft JOIN public.commande_ligne line ON line.id=draft.commande_ligne_id WHERE draft.revision_id=$1::uuid",
            [revisionId],
          )
        ).rows[0].delai_client,
      ).toBe(due);
      await expect(
        executeIndustrialProposals(
          queued.id,
          { proposal_indexes: [proposalIndex], request_key: requestKey },
          audit(),
        ),
      ).resolves.toMatchObject({ replayed: true });

      const coverageTx = await pool.connect();
      let coverage;
      try {
        await coverageTx.query(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        coverage = await readClientContractCoverageTx(
          coverageTx,
          client,
          contractId,
          { start_month: start.slice(0, 7), months: 18 },
        );
        await coverageTx.query("COMMIT");
      } finally {
        await coverageTx.query("ROLLBACK");
        coverageTx.release();
      }
      const prepared = await prepareClientReplenishment(
        client,
        contractId,
        {
          action: "PREPARE",
          expected_contract_version: coverage.report.contract_version,
          expected_plan_id: null,
          expected_snapshot_hash: coverage.report.snapshot_hash,
          start_month: start.slice(0, 7),
          months: 18,
        },
        randomUUID(),
        audit(),
      );
      expect(prepared.result.plan.proposals).toHaveLength(1);
      const contractProposal = prepared.result.plan.proposals[0];
      expect(contractProposal).toMatchObject({
        contract_line_id: contractLineId,
        target_date: expectedContractTarget,
        proposed_quantity: visionQuantity.toFixed(3),
        surplus_quantity: "0.000",
      });

      const secondRun = await enqueueIndustrialRun(
        {
          client_id: client,
          start,
          label: "Vision Systems OF après préparation contractuelle",
          capacity_percent: 100,
          months: 18,
          weeks: 26,
        },
        actor,
      );
      const secondReady = await processRun(secondRun.id);
      expect(secondReady.status).toBe("READY");
      // The API/read-model must expose recovery alongside PDP, not only hide it
      // in the freshness digest used for validation.
      const persistedSecond = await industrialRunById(secondRun.id);
      expect(persistedSecond.result).toHaveProperty("contract_target_recovery");
      expect(persistedSecond.result.contract_target_recovery).toEqual(
        expect.any(Array),
      );
      const secondProposalIndex = secondReady.result.proposals.findIndex(
        (proposal: IndustrialProposal) =>
          proposal.kind === "MAKE" &&
          proposal.article_id === article &&
          proposal.quantity === visionQuantity &&
          proposal.due === due,
      );
      expect(secondProposalIndex).toBeGreaterThanOrEqual(0);
      await expect(
        validateIndustrialRun(secondRun.id, actor),
      ).resolves.toMatchObject({
        status: "VALIDATED",
      });
      const afterPreparation = await executeIndustrialProposals(
        secondRun.id,
        { proposal_indexes: [secondProposalIndex], request_key: randomUUID() },
        audit(),
      );
      expect(afterPreparation.outcomes[0]).toMatchObject({
        proposal_index: secondProposalIndex,
        status: "REVIEW",
        reason: expect.stringContaining(`${visionQuantity} U au ${due}`),
      });
      expect(
        (
          await pool.query<{ delai_client: string }>(
            "SELECT line.delai_client::text FROM public.demand_pilot_firm_draft_lines draft JOIN public.commande_ligne line ON line.id=draft.commande_ligne_id WHERE draft.revision_id=$1::uuid",
            [revisionId],
          )
        ).rows[0].delai_client,
      ).toBe(due);
      expect(afterPreparation.outcomes[0]).toMatchObject({
        reason: expect.stringContaining(
          `au ${expectedContractTarget} (surplus 0)`,
        ),
      });
    });

    it("keeps the MAKE proposal visible after the contract REVIEW without inventing an OF", async () => {
      const start = (
        await pool.query<{ today: string }>(
          "SELECT CURRENT_DATE::text AS today",
        )
      ).rows[0].today;
      const queued = await enqueueIndustrialRun(
        {
          client_id: client,
          start,
          label: "Vision Systems coverage after OF",
          capacity_percent: 100,
          months: 18,
          weeks: 26,
        },
        actor,
      );
      const ready = await processRun(queued.id);
      expect(ready.status).toBe("READY");
      expect(
        ready.result.proposals.some(
          (proposal: IndustrialProposal) =>
            proposal.kind === "MAKE" &&
            proposal.article_id === article &&
            proposal.due === due,
        ),
      ).toBe(true);
    });
  },
);
