import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  CUMP_DECIMAL_SCALE,
  formatCumpDecimal,
  parseCumpDecimal,
} from "../../stock/domain/cump-decimal";
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import { readCentralSnapshot } from "../../planning/repository/planning-central.repository";
import { readOfComponentCoverageTx } from "../../production/repository/of-component-coverage.repository";
import type {
  ContractCoverageIssue,
  ContractCoverageSupply,
} from "../types/client-contract-coverage.types";

type Queryer = Pick<PoolClient, "query">;
type Owner = {
  id: string;
  order_line_id: string | null;
  quantity: string;
  received: string;
};
type Producer = {
  id: number;
  number: string;
  article_id: string;
  unit: string;
  launched: string;
  received: string;
  good: string;
  scrap: string;
  status: string;
  order_line_id: string | null;
  owners: Owner[];
  surplus: string | null;
  operation_count: number;
  task_ids: string[];
  forecast_issues: string[];
  industrial_semantics: unknown | null;
  consolidation_semantics: unknown | null;
};
const positive = (value: bigint) => (value > 0n ? value : 0n);
const minimum = (a: bigint, b: bigint) => (a < b ? a : b);
const maximum = (a: bigint, b: bigint) => (a > b ? a : b);

type IndustrialGoodOutputSemantics = {
  coverage_semantics: "GOOD_OUTPUT_V1";
  launched_quantity?: string | number;
  expected_good_quantity: string | number;
  yield_percent: string | number;
};

type ConsolidationGoodOutputSemantics = {
  coverage_semantics: "CONSOLIDATION_GOOD_OUTPUT_V1";
  allocated_good_quantity: string | number;
  raw_surplus_quantity: string | number;
};

function expectedGoodFromCurrentLaunch(
  launched: bigint,
  yieldPercent: bigint,
  unit: string | undefined,
) {
  const precision =
    canonicalizeStockUnitCode(unit) === "u"
      ? CUMP_DECIMAL_SCALE
      : CUMP_DECIMAL_SCALE / 1_000n;
  return (
    (launched * yieldPercent) /
    (100n * CUMP_DECIMAL_SCALE * precision) *
    precision
  );
}

function allocatedConsolidationGoodOutput(semantics: unknown | null) {
  const token = semantics as Partial<ConsolidationGoodOutputSemantics> | null;
  if (
    token?.coverage_semantics !== "CONSOLIDATION_GOOD_OUTPUT_V1" ||
    token.allocated_good_quantity === undefined
  )
    return null;
  try {
    return positive(parseCumpDecimal(String(token.allocated_good_quantity)));
  } catch {
    return null;
  }
}

/**
 * Only OFs carrying the immutable execution token use yield-aware coverage.
 * Historical/manual OFs keep their legacy semantics: their launched quantity
 * is not reinterpreted from a mutable article rule during a later recalculation.
 */
export function remainingIndustrialGoodOutput(input: {
  launched: string;
  received: string;
  good: string;
  scrap: string;
  unit?: string;
  semantics: unknown | null;
}) {
  const legacy = positive(
    parseCumpDecimal(input.launched) -
      parseCumpDecimal(input.received) -
      parseCumpDecimal(input.scrap),
  );
  const token =
    input.semantics as Partial<IndustrialGoodOutputSemantics> | null;
  if (token?.coverage_semantics !== "GOOD_OUTPUT_V1") return legacy;
  if (
    token.expected_good_quantity === undefined ||
    token.yield_percent === undefined
  )
    return 0n;
  try {
    const expected = positive(
      parseCumpDecimal(String(token.expected_good_quantity)),
    );
    const yieldPercent = parseCumpDecimal(String(token.yield_percent));
    if (yieldPercent <= 0n || yieldPercent > 100n * CUMP_DECIMAL_SCALE)
      return 0n;

    const initialLaunch =
      token.launched_quantity === undefined
        ? null
        : positive(parseCumpDecimal(String(token.launched_quantity)));
    const currentLaunch = parseCumpDecimal(input.launched);
    // The immutable expected output is retained for the unmodified OF. When
    // its draft quantity changes, recompute from that current gross quantity
    // and the frozen yield; never from a mutable article setting.
    const recalculatedExpected =
      initialLaunch !== null && currentLaunch !== initialLaunch
        ? expectedGoodFromCurrentLaunch(currentLaunch, yieldPercent, input.unit)
        : expected;
    // The margin embedded in `expected` already covers the planned yield
    // loss.  A confirmed scrap only reduces it once it exceeds that margin:
    // `min(expected good, launched - scrap)`.  `quantite_bonne` and output
    // lots can be two views of one physical output, hence the maximum.
    const forecastGood = minimum(
      recalculatedExpected,
      positive(currentLaunch - parseCumpDecimal(input.scrap)),
    );
    const actualGood = maximum(
      parseCumpDecimal(input.good),
      parseCumpDecimal(input.received),
    );
    return positive(forecastGood - actualGood);
  } catch {
    return 0n;
  }
}

export const CONTRACT_COVERAGE_PRODUCERS_SQL = `SELECT o.id::bigint::int,o.numero AS number,o.article_id::text,
  upper(btrim(a.unite)) AS unit,o.quantite_lancee::text AS launched,o.quantite_bonne::text AS good,
  o.quantite_rebut::text AS scrap,o.statut::text AS status,o.commande_ligne_id::text AS order_line_id,
  COALESCE((SELECT sum(output.qty_ok) FROM public.of_output_lots output WHERE output.of_id=o.id),0)::text AS received,
  (SELECT execution.result->'industrial_proposal'
     FROM public.industrial_proposal_executions execution
    WHERE execution.target_type='OF' AND execution.target_id=o.id::text
      AND execution.status='EXECUTED' AND execution.action='MAKE'
      AND execution.result->'industrial_proposal'->>'coverage_semantics'='GOOD_OUTPUT_V1'
    ORDER BY execution.created_at DESC,execution.id DESC LIMIT 1) AS industrial_semantics,
  o.technical_preparation->'consolidation_good_output' AS consolidation_semantics,
  c.surplus_quantity::text AS surplus,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',share.id::text,'order_line_id',source.commande_ligne_id::text,
    'quantity',share.quantity::text,'received',share.received_quantity::text) ORDER BY share.due_date NULLS LAST,share.id)
    FROM public.production_consolidation_allocations share JOIN public.ordres_fabrication source ON source.id=share.source_of_id
    WHERE share.consolidation_id=c.id AND share.state='ACTIVE'),'[]'::jsonb) AS owners,
  (SELECT count(*)::int FROM public.of_operations op WHERE op.of_id=o.id AND op.status::text<>'CANCELLED'
    AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))) AS operation_count,
  COALESCE((SELECT array_agg(t.id ORDER BY t.id) FROM public.planning_tasks t LEFT JOIN public.of_operations op ON op.id=t.operation_id
    LEFT JOIN public.piece_version_programming_tasks program ON program.id=t.version_programming_id
    WHERE (op.of_id=o.id AND op.status::text<>'CANCELLED' AND(op.revision_id IS NULL OR EXISTS(
      SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE')))
      OR t.draft_of_id=o.id OR program.of_id=o.id),'{}'::text[]) AS task_ids,
  COALESCE((SELECT array_agg(DISTINCT issue.value ORDER BY issue.value) FROM public.planning_tasks t
    JOIN public.of_operations op ON op.id=t.operation_id
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(t.forecast_issues,'[]'::jsonb)) issue(value)
    WHERE op.of_id=o.id AND op.status::text<>'CANCELLED' AND(op.revision_id IS NULL OR EXISTS(
      SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))),'{}'::text[]) AS forecast_issues
  FROM public.ordres_fabrication o JOIN public.articles a ON a.id=o.article_id
  LEFT JOIN public.production_consolidations c ON c.producer_of_id=o.id AND c.state='ACTIVE'
  WHERE o.article_id=ANY($1::uuid[]) AND o.parent_of_id IS NULL
    AND o.statut::text NOT IN ('ANNULE','TERMINE','CLOTURE')
    AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations share
      JOIN public.production_consolidations grouped ON grouped.id=share.consolidation_id
      WHERE share.source_of_id=o.id AND share.state='ACTIVE' AND grouped.state='ACTIVE')
  ORDER BY o.id LIMIT 501`;

export async function readContractCoverageProduction(
  db: Queryer,
  input: { articleIds: readonly string[]; now: string; endDate: string },
) {
  const producers = (
    await db.query<Producer>(CONTRACT_COVERAGE_PRODUCERS_SQL, [
      input.articleIds,
    ])
  ).rows;
  if (producers.length > 500)
    throw new HttpError(
      422,
      "CONTRACT_COVERAGE_SCOPE_TOO_LARGE",
      "Le calcul dépasse 500 producteurs OF.",
    );
  const taskIds = producers.flatMap((producer) => producer.task_ids);
  if (taskIds.length > 5000)
    throw new HttpError(
      422,
      "CONTRACT_COVERAGE_SCOPE_TOO_LARGE",
      "Le calcul dépasse 5 000 opérations.",
    );
  const sources: ContractCoverageSupply[] = [],
    issues: ContractCoverageIssue[] = [];
  if (!taskIds.length) {
    if (producers.length)
      issues.push({
        code: "UNPLANNED_PRODUCTION_EXCLUDED",
        message:
          "Les OF sans opérations engagées restent exclus de la couverture.",
      });
    return { sources, issues, revision: null };
  }
  if (input.endDate < input.now.slice(0, 10))
    return {
      sources,
      issues: [
        {
          code: "HISTORICAL_PRODUCTION_EXCLUDED",
          message:
            "Les OF actuels ne constituent pas une couverture historique des mois déjà passés.",
        },
      ],
      revision: null,
    };
  // Coverage checks dated commitments and whether their resources are enabled.
  // It never searches for new slots across the long PIC horizon.
  const snapshot = await readCentralSnapshot(
    {
      from: input.now,
      to: `${input.endDate}T23:59:59Z`,
      limit: 5000,
      includeTaskIds: taskIds,
      taskIdsOnly: true,
      includeResourceAvailability: false,
    },
    db,
  );
  if (snapshot.nextCursor)
    throw new HttpError(
      422,
      "CONTRACT_COVERAGE_SCOPE_TOO_LARGE",
      "Le planning dépasse le périmètre complet de la synthèse.",
    );
  const resourceById = new Map(
    snapshot.resources.map((resource) => [resource.id, resource]),
  );
  for (const producer of producers) {
    const exclude = (code: string, message: string) =>
      issues.push({ code, message });
    if (!["PLANIFIE", "EN_COURS", "EN_PAUSE"].includes(producer.status)) {
      exclude(
        "DRAFT_PRODUCTION_EXCLUDED",
        "Les OF brouillons ne sont pas une couverture engagée.",
      );
      continue;
    }
    const tasks = snapshot.tasks.filter((task) => task.ofId === producer.id);
    const operationTasks = tasks.filter((task) => task.source === "OPERATION");
    if (
      !producer.operation_count ||
      operationTasks.length !== producer.operation_count ||
      tasks.length !== producer.task_ids.length ||
      producer.forecast_issues.length ||
      tasks.some(
        (task) =>
          task.readiness !== "READY" ||
          task.blockers.length ||
          task.commitment === "FORECAST",
      )
    ) {
      exclude(
        "UNSECURED_PRODUCTION_EXCLUDED",
        "Des OF attendent une définition, un engagement ou la résolution de blocages au planning.",
      );
      continue;
    }
    const expectedReleasedGood = remainingIndustrialGoodOutput({
      launched: producer.launched,
      received: "0",
      good: "0",
      scrap: producer.scrap,
      unit: producer.unit,
      semantics: producer.industrial_semantics,
    });
    if (
      parseCumpDecimal(producer.good) > parseCumpDecimal(producer.received) ||
      (operationTasks.every((task) => task.commitment === "DONE") &&
        parseCumpDecimal(producer.received) < expectedReleasedGood)
    ) {
      exclude(
        "UNRELEASED_OUTPUT_EXCLUDED",
        "Des pièces déjà fabriquées attendent leur réception ou leur libération et restent exclues.",
      );
      continue;
    }
    let end = "";
    let invalid = false;
    for (const task of tasks) {
      const finished = task.commitment === "DONE";
      const candidate = finished ? task.actual?.end : task.committed?.end;
      if (
        !candidate ||
        (!finished && (candidate <= input.now || !task.resourceIds.length)) ||
        (!finished &&
          task.resourceIds.some(
            (id) =>
              !resourceById.has(id) ||
              resourceById.get(id)!.capacityEnabled === false,
          ))
      ) {
        invalid = true;
        break;
      }
      const realizable =
        !finished && task.forecast?.end && task.forecast.end > candidate
          ? task.forecast.end
          : candidate;
      if (realizable > end) end = realizable;
    }
    const material = snapshot.demands.flatMap((demand) =>
      demand.coverage?.ofId === producer.id ? [demand.coverage] : [],
    );
    if (
      !snapshot.coverageAvailable ||
      material.some((coverage) => {
        const start = operationTasks.find(
          (task) => task.operationId === coverage.operationId,
        )?.committed?.start;
        return (
          coverage.unsecured > 0 ||
          coverage.issues.length ||
          (coverage.availableAt && start && coverage.availableAt > start)
        );
      })
    )
      invalid = true;
    const components = await readOfComponentCoverageTx(db, producer.id);
    if (!components.ready) invalid = true;
    if (invalid || !end) {
      exclude(
        "PRODUCTION_DATE_REVIEW_REQUIRED",
        "Des OF doivent être replanifiés ou sécurisés en matière et composants avant de couvrir le besoin.",
      );
      continue;
    }
    const availableDate = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Paris",
    }).format(new Date(end));
    const consolidationAllocation = allocatedConsolidationGoodOutput(
      producer.consolidation_semantics,
    );
    let remaining =
      consolidationAllocation === null
        ? remainingIndustrialGoodOutput({
            launched: producer.launched,
            received: producer.received,
            good: producer.good,
            scrap: producer.scrap,
            unit: producer.unit,
            semantics: producer.industrial_semantics,
          })
        : minimum(
            remainingIndustrialGoodOutput({
              launched: producer.launched,
              received: "0",
              good: "0",
              scrap: producer.scrap,
              unit: producer.unit,
              semantics: producer.industrial_semantics,
            }),
            consolidationAllocation,
          );
    const add = (id: string, quantity: bigint, lineId: string | null) => {
      const accepted = minimum(remaining, quantity);
      if (!accepted) return;
      remaining -= accepted;
      sources.push({
        id,
        kind: "PRODUCTION",
        article_id: producer.article_id,
        unit: producer.unit,
        quantity: formatCumpDecimal(accepted),
        available_date: availableDate,
        order_line_id: lineId,
        allocation_id: null,
        reference_id: String(producer.id),
        label: producer.number,
      });
    };
    if (consolidationAllocation !== null) {
      // Consolidated surplus is gross input, not future good output. Shares
      // alone carry the allocated good quantity; already received shares are
      // covered by stock rather than by this future-production source.
      for (const owner of producer.owners)
        add(
          `production:${producer.id}:share:${owner.id}`,
          positive(
            parseCumpDecimal(owner.quantity) - parseCumpDecimal(owner.received),
          ),
          owner.order_line_id,
        );
    } else if (producer.surplus !== null) {
      for (const owner of producer.owners)
        add(
          `production:${producer.id}:share:${owner.id}`,
          positive(
            parseCumpDecimal(owner.quantity) - parseCumpDecimal(owner.received),
          ),
          owner.order_line_id,
        );
      const attributedReceived = producer.owners.reduce(
        (sum, owner) => sum + parseCumpDecimal(owner.received),
        0n,
      );
      const surplusReceived = positive(
        parseCumpDecimal(producer.received) - attributedReceived,
      );
      add(
        `production:${producer.id}:surplus`,
        positive(parseCumpDecimal(producer.surplus) - surplusReceived),
        null,
      );
    } else add(`production:${producer.id}`, remaining, producer.order_line_id);
  }
  return { sources, issues, revision: snapshot.revision };
}
