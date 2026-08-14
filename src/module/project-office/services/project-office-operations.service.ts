import { HttpError } from "../../../utils/httpError";
import { decimal, money } from "../../margin-engine/domain/margin-engine";
import { svcGetMargin } from "../../margin-engine/services/margin-engine.service";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import {
  repoAffaireExists,
  repoCreateProjectAffaireLink,
  repoCreateProjectBudgetVersion,
  repoDeleteProjectAffaireLink,
  repoGetCurrentProjectBudget,
  repoGetProjectBurnUp,
  repoGetProjectRiskMatrix,
  repoGetProjectTimeBudget,
  repoListBlockingDependencies,
  repoListOverdueMilestones,
  repoListProjectAffaireLinks,
} from "../repository/project-office-operations.repository";
import type { Actor } from "../types/project-office.types";
import type { CreateProjectBudgetDTO, LinkProjectAffaireDTO } from "../validators/project-office.validators";
import { canManage, requireProjectAccess } from "./project-office-access.service";

function addMoney(values: string[]): string {
  return money(values.reduce((sum, value) => sum + decimal(value), 0n));
}

export async function getProjectOperations(actor: Actor, projectId: string) {
  const access = await requireProjectAccess(actor, projectId, "read");
  const [budget, links, timeBudget, overdueMilestones, blockingDependencies, burnUp, riskMatrix] = await Promise.all([
    repoGetCurrentProjectBudget(projectId),
    repoListProjectAffaireLinks(projectId),
    repoGetProjectTimeBudget(projectId),
    repoListOverdueMilestones(projectId),
    repoListBlockingDependencies(projectId),
    repoGetProjectBurnUp(projectId),
    repoGetProjectRiskMatrix(projectId),
  ]);

  const affairCosts = await Promise.all(links.map(async (link) => {
    const comparison = await svcGetMargin("AFFAIRE", String(link.affaire_id));
    return {
      ...link,
      cost_total_ht: comparison.actual.cost_total_ht,
      partial_cost_total_ht: comparison.actual.partial_cost_total_ht,
      reliability: comparison.actual.reliability,
      freshness_at: comparison.actual.freshness_at,
      missing_inputs: comparison.actual.missing_inputs,
      calculation_hash: comparison.actual.calculation_hash,
    };
  }));

  const completeCosts = affairCosts.every((row) => row.cost_total_ht !== null);
  const consumed = affairCosts.length === 0
    ? null
    : completeCosts
      ? addMoney(affairCosts.map((row) => row.cost_total_ht!))
      : null;
  const partialConsumed = affairCosts.length === 0
    ? null
    : addMoney(affairCosts.map((row) => row.partial_cost_total_ht));
  const comparable = Boolean(budget && budget.currency === "EUR" && consumed !== null);
  const remaining = comparable ? money(decimal(budget!.amount) - decimal(consumed!)) : null;
  const quality: string[] = [];
  if (!budget) quality.push("PROJECT_BUDGET_MISSING");
  if (links.length === 0) quality.push("PROJECT_AFFAIRE_LINK_MISSING");
  if (links.length > 0 && !completeCosts) quality.push("ACTUAL_COSTS_PARTIAL");
  if (budget && budget.currency !== "EUR") quality.push("BUDGET_CURRENCY_NOT_COMPARABLE");
  if (timeBudget.planned_missing_count > 0) quality.push("PLANNED_HOURS_PARTIAL");
  if (timeBudget.consumed_missing_count > 0) quality.push("CONSUMED_HOURS_PARTIAL");

  return {
    generated_at: new Date().toISOString(),
    permissions: { can_manage: canManage(access) },
    financial: {
      budget,
      consumed_ht: consumed,
      partial_consumed_ht: partialConsumed,
      remaining_ht: remaining,
      currency: budget?.currency ?? "EUR",
      reliability: !budget || links.length === 0 ? "UNAVAILABLE" : completeCosts ? "ACTUAL" : "PARTIAL",
      definition: "Budget courant moins coûts constatés complets des affaires liées. Un coût partiel n'est jamais soustrait comme s'il était complet.",
      period: budget ? { start: budget.effective_from, end: budget.effective_to } : null,
      source: "project_budget_versions + margin-engine(AFFAIRE, ACTUAL)",
      freshness_at: affairCosts.map((row) => row.freshness_at).filter(Boolean).sort()[0] ?? budget?.observed_at ?? null,
      affaires: affairCosts,
    },
    source_links: affairCosts.map((row) => ({
      entity_type: "AFFAIRE" as const,
      entity_id: String(row.affaire_id),
      label: row.affaire_reference,
      href: `/affaires/${row.affaire_id}`,
      source_ref: row.source_ref,
      calculation_hash: row.calculation_hash,
    })),
    hours: {
      ...timeBudget,
      unit: "hour",
      reliability: timeBudget.planned_missing_count === 0 && timeBudget.consumed_missing_count === 0 ? "VERIFIED" : "PARTIAL",
      definition: "Somme des heures prévues et consommées renseignées sur les lots de travail non annulés.",
      source: "project_work_packages",
    },
    overdue_milestones: overdueMilestones,
    blocking_dependencies: blockingDependencies,
    burn_up: {
      points: burnUp,
      unit: "work_package",
      reliability: "ESTIMATED",
      definition: "Cumul prévu par échéance et cumul terminé selon la dernière date de mise à jour; l'historique de terminaison antérieur n'est pas reconstruit.",
      source: "project_work_packages",
    },
    risk_matrix: riskMatrix,
    data_quality: quality,
  };
}

export async function createProjectBudget(
  actor: Actor,
  projectId: string,
  input: CreateProjectBudgetDTO,
  audit: AuditContext,
) {
  await requireProjectAccess(actor, projectId, "manage");
  return withTransaction(async (tx) => {
    const current = await repoGetCurrentProjectBudget(projectId, tx);
    if (current && input.effective_from <= current.effective_from) {
      throw new HttpError(409, "PO_BUDGET_EFFECTIVE_DATE_INVALID", "La nouvelle version doit commencer après la version courante.");
    }
    const created = await repoCreateProjectBudgetVersion(tx, {
      project_id: projectId,
      amount: input.amount,
      currency: input.currency,
      effective_from: input.effective_from,
      definition: input.definition,
      source_type: input.source_type,
      source_ref: input.source_ref ?? null,
      observed_at: input.observed_at,
      reliability: input.reliability,
      supersedes_id: current?.id ?? null,
      created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "budget", entity_id: created.id, action: "version.create",
      actor_id: actor.id, before_json: current, after_json: created,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.budget.version.create", entity_type: "project_budget_versions", entity_id: created.id,
      details: { project_id: projectId, currency: created.currency, effective_from: created.effective_from, supersedes_id: created.supersedes_id },
    });
    return created;
  });
}

export async function linkProjectAffaire(
  actor: Actor,
  projectId: string,
  input: LinkProjectAffaireDTO,
  audit: AuditContext,
) {
  await requireProjectAccess(actor, projectId, "manage");
  if (!(await repoAffaireExists(input.affaire_id))) {
    throw new HttpError(404, "PO_AFFAIRE_NOT_FOUND", "Affaire introuvable.");
  }
  try {
    return await withTransaction(async (tx) => {
      const link = await repoCreateProjectAffaireLink(tx, {
        project_id: projectId, affaire_id: input.affaire_id, source_ref: input.source_ref ?? null, created_by: actor.id,
      });
      await insertProjectActivity(tx, {
        project_id: projectId, entity_type: "affaire_link", entity_id: link.id, action: "create",
        actor_id: actor.id, after_json: { affaire_id: link.affaire_id, affaire_reference: link.affaire_reference },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.affaire.link", entity_type: "project_affaire_links", entity_id: link.id,
        details: { project_id: projectId, affaire_id: link.affaire_id },
      });
      return link;
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) throw new HttpError(409, "PO_AFFAIRE_ALREADY_LINKED", "Cette affaire est déjà liée au projet.");
    throw error;
  }
}

export async function unlinkProjectAffaire(
  actor: Actor,
  projectId: string,
  linkId: string,
  audit: AuditContext,
) {
  await requireProjectAccess(actor, projectId, "manage");
  return withTransaction(async (tx) => {
    const removed = await repoDeleteProjectAffaireLink(tx, projectId, linkId);
    if (!removed) throw new HttpError(404, "PO_AFFAIRE_LINK_NOT_FOUND", "Lien affaire introuvable.");
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "affaire_link", entity_id: linkId, action: "delete",
      actor_id: actor.id, before_json: { link_id: linkId },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.affaire.unlink", entity_type: "project_affaire_links", entity_id: linkId,
      details: { project_id: projectId },
    });
    return { removed: true };
  });
}
