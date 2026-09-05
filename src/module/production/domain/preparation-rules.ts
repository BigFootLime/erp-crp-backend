import { createHash } from "node:crypto";

export const PREPARATION_RULES_VERSION = 1;
export type PreparationStatus =
  | "READY"
  | "MISSING"
  | "BLOCKED"
  | "NOT_REQUIRED";
export type PreparationItem = {
  key: string;
  label: string;
  status: PreparationStatus;
  required: boolean;
  detail: string;
  scope: "VERSION" | "OF";
};
export type PreparationDecisions = {
  material?: { mode: "REQUIRED" | "NOT_REQUIRED"; reason?: string };
  treatment?: { mode: "REQUIRED" | "NOT_REQUIRED"; reason?: string };
  subcontract?: { mode: "REQUIRED" | "NOT_REQUIRED"; reason?: string };
  programming?: {
    mode: "NONE" | "EXISTING" | "TASK";
    reason?: string;
    reference?: string;
    task_id?: string;
    estimated_hours?: number;
  };
  manufacturing_plan_required?: boolean;
};
export type PurchaseEvidence = {
  id: string;
  type_achat: string;
  article_id: string | null;
  designation: string | null;
  quantite: number;
  unite_prix: string | null;
  fournisseur_id: string | null;
  piece_technique_version_id: string | null;
};
export type PreparationFacts = {
  version_id: string | null;
  version_status: string | null;
  version_current: boolean;
  manufacturing_mode: string;
  decisions: PreparationDecisions;
  purchases: PurchaseEvidence[];
  client_plan_count: number;
  manufacturing_plan_count: number;
  required_documents_missing: number;
  routing_count: number;
  invalid_operations: number;
  component_count: number;
  invalid_components: number;
  quality_plan_id: string | null;
  quality_characteristic_count: number;
  programming_task_valid: boolean;
  programming_reference_valid?: boolean;
  stock_review_current: boolean;
  sheet_current: boolean;
};

/** Stable nested-object order; arrays preserve the domain order of phases and allocations. */
export function sourceHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function evaluatePreparation(f: PreparationFacts): PreparationItem[] {
  const items: PreparationItem[] = [];
  const add = (
    key: string,
    label: string,
    ready: boolean,
    detail: string,
    scope: "VERSION" | "OF" = "VERSION",
    required = true,
  ) => {
    items.push({
      key,
      label,
      status: ready ? "READY" : required ? "MISSING" : "NOT_REQUIRED",
      required,
      detail,
      scope,
    });
  };
  add(
    "index",
    "Indice technique",
    Boolean(f.version_id) &&
      f.version_status === "APPLICABLE" &&
      f.version_current,
    "Version applicable et courante requise.",
  );
  add(
    "plan",
    "Plan client",
    f.client_plan_count > 0,
    "Plan GED applicable, propre et lié à cet indice.",
  );
  add(
    "manufacturing_plan",
    "Plan de fabrication",
    f.manufacturing_plan_count > 0,
    "Plan atelier de cet indice.",
    "VERSION",
    f.decisions.manufacturing_plan_required === true,
  );
  add(
    "documents",
    "Documents requis",
    f.required_documents_missing === 0,
    "Exigences documentaires de la révision.",
  );
  for (const [key, label, category] of [
    ["material", "Matière première", "MATIERE"],
    ["treatment", "Traitements (TR)", "TRAITEMENT"],
    ["subcontract", "Sous-traitance", "SOUS_TRAITANCE"],
  ] as const) {
    const decision = f.decisions[key];
    const rows = f.purchases.filter(
      (p) =>
        p.type_achat === category &&
        p.piece_technique_version_id === f.version_id,
    );
    const notRequired =
      decision?.mode === "NOT_REQUIRED" &&
      (decision.reason?.trim().length ?? 0) >= 3 &&
      rows.length === 0;
    const complete =
      rows.length > 0 &&
      rows.every(
        (p) =>
          p.article_id &&
          p.quantite > 0 &&
          p.unite_prix?.trim() &&
          p.designation?.trim() &&
          (category === "MATIERE" || p.fournisseur_id),
      );
    add(
      key,
      label,
      complete,
      notRequired
        ? decision!.reason!
        : "Articles, quantités, unités et prestations définis pour cet indice.",
      "VERSION",
      !notRequired,
    );
  }
  add(
    "structure",
    "Structure de fabrication",
    f.invalid_components === 0 &&
      (f.manufacturing_mode === "ASSEMBLY"
        ? f.component_count > 0
        : f.component_count === 0),
    "Composants cohérents avec le mode de fabrication.",
  );
  add(
    "routing",
    "Gamme",
    f.routing_count > 0 && f.invalid_operations === 0,
    "Gamme applicable, opérations, ressources et temps renseignés.",
  );
  add(
    "quality",
    "Plan de contrôle",
    Boolean(f.quality_plan_id) && f.quality_characteristic_count > 0,
    "Plan publié pour cet indice, avec caractéristiques de contrôle.",
  );
  const p = f.decisions.programming;
  const programReady =
    p?.mode === "NONE"
      ? (p.reason?.trim().length ?? 0) >= 3
      : p?.mode === "EXISTING"
        ? (p.reference?.trim().length ?? 0) > 0 &&
          f.programming_reference_valid === true
        : p?.mode === "TASK" &&
          Boolean(p.task_id) &&
          (p.estimated_hours ?? 0) > 0 &&
          f.programming_task_valid;
  add(
    "programming",
    "Programmation",
    Boolean(programReady),
    "Décider : sans programme, programme référencé, ou tâche affectée et estimée.",
  );
  add(
    "stock_compatibility",
    "Stock et anciens indices",
    f.stock_review_current,
    "Décision propre à cet OF, à renouveler si les disponibilités changent.",
    "OF",
  );
  add(
    "self_inspection",
    "Fiche d’autocontrôle",
    f.sheet_current,
    "Fiche vierge générée depuis le plan publié et la définition courante.",
    "OF",
  );
  return items;
}

export function isPreparationReady(items: readonly PreparationItem[]): boolean {
  return items.every((x) => !x.required || x.status === "READY");
}

export function planningUrgency(params: {
  now: Date;
  waitStartedAt: string | null;
  status: string;
  totalOperations: number;
  plannedOperations: number;
  covered: boolean;
}) {
  const eligible =
    ["BROUILLON", "PLANIFIE"].includes(params.status) && !params.covered;
  const complete =
    params.totalOperations > 0 &&
    params.plannedOperations >= params.totalOperations;
  const start = params.waitStartedAt
    ? new Date(params.waitStartedAt).getTime()
    : NaN;
  const due = start + 48 * 60 * 60 * 1000;
  return {
    planning_state: complete
      ? "COMPLETE"
      : params.plannedOperations > 0
        ? "PARTIAL"
        : "NONE",
    overdue:
      eligible &&
      !complete &&
      Number.isFinite(due) &&
      params.now.getTime() >= due,
    deadline: Number.isFinite(due) ? new Date(due).toISOString() : null,
  };
}
