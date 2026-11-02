import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { roleHasOfCapability } from "../../production/domain/of-rbac";
import { createRecursiveOrdresFabrication } from "../../production/domain/of-generation";
import { roleHasCommandeFournisseurCapability } from "../../commande-fournisseur/domain/commande-fournisseur-rbac";
import { repoCreateCommandeFournisseur } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import { readReplenishmentPlan } from "../../client/repository/client-contract-replenishment.repository";
import { lockContractArticles } from "../../client/repository/client-contract.repository";
import { readClientContractCoverageTx } from "../../client/services/client-contract-coverage.service";
import { readReplenishmentProducerIntents } from "../../client/repository/client-contract-replenishment-intents.repository";
import { prepareContractReplenishmentWithIntents } from "../../client/domain/client-contract-replenishment-intent-preparation";
import { launchPreparedContractReplenishmentTx } from "../../client/services/client-contract-replenishment-launch-tx";
import {
  industrialTx,
  assertValidatedIndustrialRunFreshTx,
} from "./industrial-runs.service";
import type {
  IndustrialProposal,
  IndustrialResult,
} from "../types/industrial-plan.types";
import type { IndustrialExecutionCommand } from "../validators/industrial-execution.validators";
import type { AuditContext } from "../repository/planning.repository";
import { findOpenIndustrialOrder } from "../repository/industrial-open-executions.repository";

type Run = {
  id: string;
  client_id: string;
  source_digest: string;
  result: IndustrialResult;
};

type YieldAwareProposal = IndustrialProposal & {
  required_good_quantity?: number;
  expected_good_quantity?: number;
  yield_percent?: number;
};

/** Persist the calculation's immutable output semantics alongside the OF link.
 * Do not infer them later from mutable article settings.  Older proposals have
 * no token and deliberately retain legacy read-model behaviour. */
export function industrialProposalSnapshot(proposal: IndustrialProposal) {
  const source = proposal as YieldAwareProposal;
  const required = source.required_good_quantity;
  const expected = source.expected_good_quantity;
  const yieldPercent = source.yield_percent;
  if (
    ![required, expected, yieldPercent].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    ) ||
    yieldPercent! > 100 ||
    expected! > proposal.quantity + Number.EPSILON
  )
    return null;
  return {
    coverage_semantics: "GOOD_OUTPUT_V1" as const,
    launched_quantity: proposal.quantity,
    required_good_quantity: required!,
    expected_good_quantity: expected!,
    yield_percent: yieldPercent!,
  };
}
const unsafe = (
  p: IndustrialProposal,
  result: IndustrialResult,
  index: number,
) => {
  const placement = (
    result as IndustrialResult & {
      placements?: {
        article_id: string;
        quantity: number;
        requested: string;
        source_ids: string[];
        status: string;
        blockers: string[];
      }[];
    }
  ).placements?.find(
    (x) =>
      x.article_id === p.article_id &&
      x.quantity === p.quantity &&
      x.requested === p.due &&
      x.source_ids.length === p.source_ids.length &&
      x.source_ids.every((sourceId) => p.source_ids.includes(sourceId)),
  );
  if (p.source_ids.some((id) => id.startsWith("target:")))
    return "Stock cible/prévision sans engagement : plafond de risque et décision requis.";
  if (p.source_ids.some((id) => id.startsWith("forecast:")))
    return "Prévision sans engagement : aucun lancement automatique.";
  if (p.issues.length) return p.issues.join(" ");
  if (!p.release) return "Date de lancement non déterminée.";
  if (
    p.kind === "MAKE" &&
    (!placement ||
      placement.status !== "CAPACITY_SIMULATED" ||
      placement.blockers.length)
  )
    return "Capacité finie non démontrée : revue de planification requise.";
  return null;
};
async function article(tx: PoolClient, id: string) {
  return (
    await tx.query<{
      code: string;
      unit: string;
      piece: string | null;
      version: string | null;
    }>(
      `SELECT a.code,upper(a.unite) unit,a.piece_technique_id::text piece,v.id::text version FROM public.articles a LEFT JOIN LATERAL(SELECT id FROM public.piece_technique_versions v WHERE v.piece_technique_id=a.piece_technique_id AND v.statut='APPLICABLE' AND(v.date_application IS NULL OR v.date_application<=CURRENT_DATE) ORDER BY v.date_application DESC NULLS LAST,v.version_interne DESC,v.created_at DESC LIMIT 1)v ON true WHERE a.id=$1::uuid`,
      [id],
    )
  ).rows[0];
}
async function persist(
  tx: PoolClient,
  input: {
    run: Run;
    index: number;
    action: string;
    status: "EXECUTED" | "REVIEW";
    key: string;
    hash: string;
    audit: AuditContext;
    reason: string;
    targetType?: string;
    targetId?: string;
    result?: unknown;
  },
) {
  await tx.query(
    `INSERT INTO public.industrial_proposal_executions(run_id,proposal_index,action,status,request_key,request_hash,source_digest,target_type,target_id,reason,result,created_by)
 VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
    [
      input.run.id,
      input.index,
      input.action,
      input.status,
      input.key,
      input.hash,
      input.run.source_digest,
      input.targetType ?? null,
      input.targetId ?? null,
      input.reason,
      JSON.stringify(input.result ?? {}),
      input.audit.user_id,
    ],
  );
}
const uuidFrom = (value: string) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function launchContractProposal(
  tx: PoolClient,
  run: Run,
  p: IndustrialProposal,
  index: number,
  key: string,
  audit: AuditContext,
) {
  const yieldSnapshot = industrialProposalSnapshot(p);
  if (
    yieldSnapshot &&
    yieldSnapshot.expected_good_quantity + Number.EPSILON < p.quantity
  ) {
    return {
      reason:
        "Le rendement impose une quantité lancée supérieure au besoin conforme. " +
        "La préparation contractuelle ne peut pas absorber cet excédent sans décision explicite.",
    } as const;
  }
  const owner = (
    await tx.query<{ contract_id: string }>(
      `SELECT contract_id::text FROM public.client_contract_lines WHERE id=$1::uuid AND active FOR SHARE`,
      [p.contract_line_id],
    )
  ).rows[0];
  if (!owner)
    return {
      reason:
        "Ligne contractuelle inactive ou modifiée : préparation contractuelle requise.",
    } as const;
  const plan = await readReplenishmentPlan(tx, owner.contract_id);
  if (!plan)
    return {
      reason:
        "Aucune préparation contractuelle courante : préparez le réapprovisionnement.",
    } as const;
  const candidates = plan.proposals.filter(
    (x) =>
      x.contract_line_id === p.contract_line_id &&
      x.article.article_id === p.article_id,
  );
  const match = candidates.find(
    (x) =>
      x.target_date === p.due &&
      Number(x.proposed_quantity) === p.quantity &&
      Number(x.surplus_quantity) === 0,
  );
  if (!match) {
    const prepared = candidates.map(
      (x) =>
        `${Number(x.proposed_quantity)} ${p.unit} au ${x.target_date} (surplus ${Number(x.surplus_quantity)})`,
    );
    return {
      reason:
        `Le PDP demande ${p.quantity} ${p.unit} au ${p.due}. ` +
        (prepared.length
          ? `La préparation contractuelle prévoit ${prepared.join(", ")}. `
          : "Aucune proposition préparée ne couvre cet article sur la ligne contractuelle. ") +
        "Vérifiez le stock réservé et la date du réapprovisionnement avant de lancer l’OF.",
    } as const;
  }
  const launched = await launchPreparedContractReplenishmentTx(tx, {
    client_id: run.client_id,
    contract_id: owner.contract_id,
    plan_id: plan.id,
    proposal_ids: [match.id],
    key: uuidFrom(`industrial-contract:${run.id}:${index}:${key}`),
    request_hash: createHash("sha256")
      .update(
        JSON.stringify({
          run: run.id,
          index,
          plan: plan.id,
          proposal: match.id,
        }),
      )
      .digest("hex"),
    audit,
    user_role: audit.role,
    rereadSharedPreparation: async (sameTx, current) => {
      await lockContractArticles(sameTx, [
        ...new Set(current.proposals.map((x) => x.article.article_id)),
      ]);
      const snapshot = await readClientContractCoverageTx(
        sameTx,
        run.client_id,
        owner.contract_id,
        { start_month: current.start_month, months: current.months },
      );
      const intents = await readReplenishmentProducerIntents(
        sameTx,
        snapshot.contract.lines.map((x) => x.proposed_article!.article_id),
        snapshot.allSources,
      );
      return prepareContractReplenishmentWithIntents({
        report: snapshot.report,
        today: snapshot.clock.today,
        allDemands: snapshot.allDemands,
        allSources: snapshot.allSources,
        allAllocations: snapshot.allAllocations,
        intents,
      });
    },
  });
  return { launched: launched.result } as const;
}
async function executeIndustrialProposalsOnce(
  runId: string,
  command: IndustrialExecutionCommand,
  audit: AuditContext,
) {
  return industrialTx(async (tx) => {
    const replay = (
      await tx.query<{
        request_hash: string;
        result: unknown;
        proposal_index: number;
        status: string;
        target_type: string | null;
        target_id: string | null;
        reason: string;
      }>(
        `SELECT request_hash,result,proposal_index,status,target_type,target_id,reason
         FROM public.industrial_proposal_executions
         WHERE created_by=$1 AND request_key=($2::text || ':' || proposal_index::text)
         ORDER BY proposal_index FOR SHARE`,
        [audit.user_id, command.request_key],
      )
    ).rows;
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          runId,
          command: {
            ...command,
            proposal_indexes: [...command.proposal_indexes].sort(
              (a, b) => a - b,
            ),
          },
        }),
      )
      .digest("hex");
    if (replay.length) {
      if (replay.some((x) => x.request_hash !== hash))
        throw new HttpError(
          409,
          "INDUSTRIAL_EXECUTION_KEY_CONFLICT",
          "Cette clé correspond à une autre décision.",
        );
      return {
        run_id: runId,
        replayed: true,
        outcomes: replay.map((x) => ({
          proposal_index: x.proposal_index,
          status: x.status,
          target_type: x.target_type,
          target_id: x.target_id,
          reason: x.reason,
          result: x.result,
        })),
      };
    }
    const run = (await assertValidatedIndustrialRunFreshTx(tx, runId)) as Run;
    const outcomes: unknown[] = [];
    for (const index of command.proposal_indexes) {
      const proposal = run.result.proposals[index];
      if (!proposal)
        throw new HttpError(
          422,
          "PROPOSAL_NOT_FOUND",
          "La proposition sélectionnée n’existe plus.",
        );
      const prior = (
        await tx.query(
          "SELECT 1 FROM public.industrial_proposal_executions WHERE run_id=$1::uuid AND proposal_index=$2 FOR SHARE",
          [runId, index],
        )
      ).rowCount;
      if (prior)
        throw new HttpError(
          409,
          "PROPOSAL_ALREADY_DECIDED",
          "Cette proposition a déjà été traitée. Actualisez le calcul.",
        );
      const blocked = unsafe(proposal, run.result, index);
      const key = `${command.request_key}:${index}`;
      const openOrder =
        !blocked && proposal.kind !== "SUBCONTRACT"
          ? await findOpenIndustrialOrder(tx, proposal)
          : undefined;
      if (blocked || openOrder || proposal.kind === "SUBCONTRACT") {
        const reason =
          blocked ??
          (openOrder
            ? `L’ordre ${openOrder} est déjà ouvert pour ce besoin. Vérifiez sa couverture avant tout lancement supplémentaire.`
            : null) ??
          "Sous-traitance : promesse fournisseur et coût à confirmer.";
        await persist(tx, {
          run,
          index,
          action: "REVIEW",
          status: "REVIEW",
          key,
          hash,
          audit,
          reason,
        });
        outcomes.push({ proposal_index: index, status: "REVIEW", reason });
        continue;
      }
      if (proposal.kind === "MAKE") {
        if (!roleHasOfCapability(audit.role, "generate"))
          throw new HttpError(
            403,
            "INDUSTRIAL_MAKE_FORBIDDEN",
            "La capacité de génération d’OF est requise.",
          );
        if (proposal.contract_line_id) {
          const contract = await launchContractProposal(
            tx,
            run,
            proposal,
            index,
            key,
            audit,
          );
          if ("reason" in contract) {
            const reason =
              contract.reason ?? "Préparation contractuelle à revoir.";
            await persist(tx, {
              run,
              index,
              action: "REVIEW",
              status: "REVIEW",
              key,
              hash,
              audit,
              reason,
            });
            outcomes.push({ proposal_index: index, status: "REVIEW", reason });
            continue;
          }
          const root = contract.launched.roots[0];
          await persist(tx, {
            run,
            index,
            action: "MAKE",
            status: "EXECUTED",
            key,
            hash,
            audit,
            reason:
              "OF créé par le lancement canonique de réapprovisionnement contractuel.",
            targetType: "OF",
            targetId: String(root.root_of_id),
            result: {
              ...contract.launched,
              industrial_proposal: industrialProposalSnapshot(proposal),
            },
          });
          outcomes.push({
            proposal_index: index,
            status: "EXECUTED",
            target_type: "OF",
            target_id: root.root_of_id,
          });
          continue;
        }
        const a = await article(tx, proposal.article_id);
        if (!a?.piece || !a.version) {
          const reason = "Dossier technique applicable manquant.";
          await persist(tx, {
            run,
            index,
            action: "REVIEW",
            status: "REVIEW",
            key,
            hash,
            audit,
            reason,
          });
          outcomes.push({ proposal_index: index, status: "REVIEW", reason });
          continue;
        }
        const generated = await createRecursiveOrdresFabrication(tx, {
          source_type: "MANUAL",
          commande_id: null,
          commande_numero: null,
          commande_ligne_id: null,
          livraison_affaire_id: null,
          client_id: run.client_id,
          root_article_id: proposal.article_id,
          root_piece_technique_id: a.piece,
          root_pinned_version_id: a.version,
          qty_to_produce: proposal.quantity,
          user_id: audit.user_id,
          force_preparation: true,
          idempotency_key: randomUUID(),
          request_hash: createHash("sha256")
            .update(`industrial:${runId}:${index}`)
            .digest("hex"),
        });
        await persist(tx, {
          run,
          index,
          action: "MAKE",
          status: "EXECUTED",
          key,
          hash,
          audit,
          reason:
            "OF créé depuis une proposition PDP validée et capacité finie vérifiée.",
          targetType: "OF",
          targetId: String(generated.root_of_id),
          result: {
            root_of_id: generated.root_of_id,
            batch_id: generated.batch_id,
            industrial_proposal: industrialProposalSnapshot(proposal),
          },
        });
        outcomes.push({
          proposal_index: index,
          status: "EXECUTED",
          target_type: "OF",
          target_id: generated.root_of_id,
        });
        continue;
      }
      if (!roleHasCommandeFournisseurCapability(audit.role, "create"))
        throw new HttpError(
          403,
          "INDUSTRIAL_BUY_FORBIDDEN",
          "La capacité de création des commandes fournisseurs est requise.",
        );
      if (!command.supplier_id) {
        const reason =
          "Fournisseur non sélectionné : brouillon d’achat à préparer.";
        await persist(tx, {
          run,
          index,
          action: "REVIEW",
          status: "REVIEW",
          key,
          hash,
          audit,
          reason,
        });
        outcomes.push({ proposal_index: index, status: "REVIEW", reason });
        continue;
      }
      const a = await article(tx, proposal.article_id);
      if (!a) {
        throw new HttpError(
          409,
          "ARTICLE_CHANGED",
          "Article introuvable : recalcul requis.",
        );
      }
      const po = await repoCreateCommandeFournisseur(
        {
          idempotency_key: randomUUID(),
          origine: "PROPOSITION_MRP",
          fournisseur_id: command.supplier_id,
          devise: "EUR",
          date_besoin: proposal.due,
          note_interne: `PDP validé ${run.id}, proposition ${index}. Commande créée en brouillon : prix et promesse fournisseur à confirmer.`,
          frais_port_ht: 0,
          tva_frais_pct: 20,
          lignes: [
            {
              type: "ARTICLE",
              article_id: proposal.article_id,
              designation: a.code,
              unite: a.unit,
              quantite: proposal.quantity,
              prix_unitaire_ht: 0,
              remise_pct: 0,
              tva_pct: 20,
              frais_ht: 0,
              date_besoin: proposal.due,
              exigences_qualite: [],
              documents_attendus: [],
              besoins: [
                {
                  besoin_type: "MANUEL",
                  besoin_ref: `industrial:${run.id}:${index}`,
                  quantite_couverte: proposal.quantity,
                },
              ],
            },
          ],
        },
        audit,
        tx,
      );
      await persist(tx, {
        run,
        index,
        action: "BUY",
        status: "EXECUTED",
        key,
        hash,
        audit,
        reason: "Brouillon OA créé : aucune dépense ni envoi automatique.",
        targetType: "COMMANDE_FOURNISSEUR",
        targetId: po.id,
        result: po,
      });
      outcomes.push({
        proposal_index: index,
        status: "EXECUTED",
        target_type: "COMMANDE_FOURNISSEUR",
        target_id: po.id,
        code: po.code,
      });
    }
    const result = { run_id: runId, outcomes };
    await repoInsertAuditLog({
      tx,
      user_id: audit.user_id,
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      body: {
        event_type: "ACTION",
        action: "INDUSTRIAL_PROPOSAL_DECIDE",
        entity_type: "industrial_plan_run",
        entity_id: runId,
        page_key: audit.page_key ?? "planning.industrial",
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: result,
      },
    });
    return result;
  }, "SERIALIZABLE");
}

export async function executeIndustrialProposals(
  runId: string,
  command: IndustrialExecutionCommand,
  audit: AuditContext,
) {
  // Each retry takes a new snapshot. OF/OA writes, the PDF outbox, and the
  // execution receipt all belong to the same database transaction.
  for (let attempt = 1; ; attempt++) {
    try {
      return await executeIndustrialProposalsOnce(runId, command, audit);
    } catch (error) {
      const { code, constraint } = error as {
        code?: string;
        constraint?: string;
      };
      const receiptConflict =
        code === "23505" &&
        (constraint ===
          "industrial_proposal_executions_created_by_request_key_key" ||
          constraint ===
            "industrial_proposal_executions_run_id_proposal_index_key");
      if (code !== "40001" && code !== "40P01" && !receiptConflict) throw error;
      if (attempt >= 3)
        throw new HttpError(
          409,
          "INDUSTRIAL_EXECUTION_BUSY",
          "Une autre décision est en cours. Réessayez avec la même clé.",
        );
    }
  }
}
