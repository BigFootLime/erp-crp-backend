import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { centralCanonicalJson } from "../../planning/domain/central-canonical-json";
import { calculateIndustrialPlan } from "../../planning/domain/industrial-plan";
import { placeIndustrialProposals } from "../../planning/domain/industrial-capacity";
import { industrialExceptions } from "../../planning/domain/industrial-exceptions";
import { readIndustrialInput } from "../../planning/repository/industrial-input.repository";
import { readIndustrialRouting } from "../../planning/repository/industrial-analysis.repository";
import { readMasterPlanSourceTx } from "../../planning/repository/planning-master-plan.repository";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import { assessDemandStock } from "../../planning/services/industrial-promise.service";
import type { DemandRow } from "../types/demand-pilot.types";

export async function simulateDemand(clientId: string, revisionId: string) {
  return industrialTx(async (tx) => {
    const row = (
      await tx.query<DemandRow & { today: string }>(
        `SELECT r.*,r.need_date::text,r.quantity::text,
    to_char(now() AT TIME ZONE 'Europe/Paris','YYYY-MM-DD') AS today FROM public.demand_pilot_revisions r
    WHERE r.id=$1 AND r.client_id=$2`,
        [revisionId, clientId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(404, "DEMAND_NOT_FOUND", "Échéance introuvable.");
    if (!row.article_id)
      throw new HttpError(
        422,
        "DEMAND_ARTICLE_REQUIRED",
        "Associez une référence CERP pour simuler cette échéance.",
      );
    const source = await readIndustrialInput(tx, clientId, row.today);
    if (!source.articles.some((a) => a.id === row.article_id))
      throw new HttpError(
        409,
        "DEMAND_ARTICLE_CHANGED",
        "L’article ne figure plus dans le périmètre du pilote.",
      );
    const evidence = await assessDemandStock(tx, {
      clientId,
      contractId: row.contract_id,
      articleId: row.article_id,
      quantity: row.quantity,
      unit: row.unit,
      needDate: row.need_date,
    });
    const baseline = calculateIndustrialPlan(source);
    // A submitted external key is not evidence that a live ERP order may be displaced.
    // Until the line is linked, retain every confirmed commitment and present the additional load.
    const id = "revision:" + row.id;
    const after = calculateIndustrialPlan({
      ...source,
      demand: [
        ...source.demand,
        {
          id,
          article: row.article_id,
          unit: row.unit.toUpperCase(),
          quantity: row.quantity,
          kind: row.kind,
          priceEur: null,
          due: row.need_date,
          contractLine: row.contract_line_id,
          orderLine: null,
          allocation: null,
        },
      ],
    });
    const master = await readMasterPlanSourceTx(tx, {
      start: row.today,
      weeks: 13,
    });
    const through = new Date(
      Date.parse(row.today + "T12:00:00Z") + 41 * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const routing = await readIndustrialRouting(
      tx,
      source.articles.map((a) => a.id),
    );
    const placements = placeIndustrialProposals({
      proposals: after.proposals,
      routing,
      snapshot: master.snapshot,
      today: row.today,
      through,
    });
    const supplyEffects = after.proposals.filter((p) =>
      p.source_ids.includes(id),
    );
    const alternatives = industrialExceptions(source, after).filter((r) =>
      r.source_ids.includes(id),
    );
    const matchingPlacements = placements.filter((p) =>
      p.source_ids.includes(id),
    );
    const options: {
      code: string;
      label: string;
      quantity?: number;
      date?: string | null;
      conditions: string[];
    }[] = [];
    if (evidence.capacity_state === "PROVEN")
      options.push({
        code: "STOCK",
        label: "Servir à la date demandée",
        quantity: Number(row.quantity),
        date: row.need_date,
        conditions: [],
      });
    else if (Number(evidence.available_quantity) > 0)
      options.push({
        code: "PARTIAL",
        label: "Proposer une livraison partielle",
        quantity: Number(evidence.available_quantity),
        date: row.need_date,
        conditions: [
          "Accord sur le fractionnement et vérification de la date du solde.",
        ],
      });
    for (const p of matchingPlacements.filter(
      (p) => p.article_id === row.article_id && p.projected_finish,
    )) {
      options.push({
        code: "CAPACITY",
        label: "Fabriquer sur un créneau simulé",
        quantity: p.quantity,
        date: p.projected_finish,
        conditions: [
          ...p.blockers,
          "Vérifier contrôle final et transport avant communication.",
        ],
      });
    }
    for (const a of alternatives.filter((e) => e.action === "ADVANCE"))
      options.push({
        code: "EXPEDITE",
        label: "Demander une avance au fournisseur",
        date: a.date,
        quantity: a.quantity,
        conditions: [a.reason],
      });
    if (!options.length)
      options.push({
        code: "REVIEW",
        label: "Arbitrage approvisionnement et atelier",
        conditions: [
          ...evidence.blockers,
          ...new Set(supplyEffects.flatMap((p) => p.issues)),
        ],
      });
    const impacts = after.pdp.flatMap((cell) => {
      const before = baseline.pdp.find(
        (b) => b.article_id === cell.article_id && b.week === cell.week,
      );
      const difference = cell.planned - (before?.planned ?? 0);
      return difference
        ? [
            {
              article: cell.article,
              unit: cell.unit,
              week: cell.week,
              quantity_delta: difference,
            },
          ]
        : [];
    });
    return {
      revision_id: row.id,
      revision_no: row.revision_no,
      scope: "EXISTING_BOOK_PLUS_REQUEST",
      before: row.before_snapshot,
      after: row.after_snapshot,
      notice:
        "Simulation conservatrice. Les engagements existants restent protégés jusqu’au rattachement commercial vérifié.",
      input_revision: createHash("sha256")
        .update(
          centralCanonicalJson([
            source,
            master.snapshot.revision,
            evidence.input_revision,
          ]),
        )
        .digest("hex"),
      available_quantity: evidence.available_quantity,
      exposure_before_eur: baseline.forecast_exposure_eur,
      exposure_after_eur: after.forecast_exposure_eur,
      purchase_and_work_order_proposals: supplyEffects,
      capacity_scenarios: matchingPlacements,
      impacts,
      options,
    };
  }, "REPEATABLE READ");
}
