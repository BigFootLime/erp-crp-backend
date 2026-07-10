// T5 — Moteur de règles (PUR, testable sans DB). Aucune valeur 35/39 en dur : tout vient soit d'un
// hr_time_rule_sets, soit — à défaut — dérivé du contrat de l'employé (ses propres heures).

export interface RoundingRule {
  unit_minutes?: number; // pas d'arrondi si absent/0
  mode?: "nearest" | "up" | "down";
}
export interface BreakRule {
  min_break_minutes?: number; // pause minimale imposée
  auto_deduct_after_minutes?: number; // au-delà de ce temps travaillé, la pause minimale est déduite
}

export interface HrRuleSet {
  id: string;
  name: string;
  weekly_target_minutes: number;
  daily_target_minutes: number;
  overtime_threshold_1_minutes: number | null; // début heures sup taux 1 (défaut = cible hebdo)
  overtime_rate_1: number | null; // ex. 1.25
  overtime_threshold_2_minutes: number | null; // début heures sup taux 2
  overtime_rate_2: number | null; // ex. 1.50
  rounding_rule: RoundingRule;
  break_rule: BreakRule;
  active: boolean;
}

// Lignes brutes DB (numeric ⇒ string via pg).
export interface ContractRow {
  id: string;
  contract_type: string;
  weekly_hours_target: string | number;
  daily_hours_target: string | number | null;
  rule_set_id: string | null;
}
export interface RuleSetRow {
  id: string;
  name: string;
  weekly_target_minutes: number;
  daily_target_minutes: number;
  overtime_threshold_1_minutes: number | null;
  overtime_rate_1: string | number | null;
  overtime_threshold_2_minutes: number | null;
  overtime_rate_2: string | number | null;
  rounding_rule: unknown;
  break_rule: unknown;
  active: boolean;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRoundingRule(raw: unknown): RoundingRule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const unit = toNum(r.unit_minutes);
  const mode = r.mode === "up" || r.mode === "down" || r.mode === "nearest" ? r.mode : undefined;
  return { ...(unit && unit > 0 ? { unit_minutes: unit } : {}), ...(mode ? { mode } : {}) };
}
export function parseBreakRule(raw: unknown): BreakRule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const minB = toNum(r.min_break_minutes);
  const after = toNum(r.auto_deduct_after_minutes);
  return {
    ...(minB && minB > 0 ? { min_break_minutes: minB } : {}),
    ...(after && after > 0 ? { auto_deduct_after_minutes: after } : {}),
  };
}

// Combine contrat + (éventuel) rule_set → règles effectives. Sans rule_set : dérive du CONTRAT
// (heures propres du salarié ⇒ jamais de 35/39 codé en dur).
export function effectiveRuleSetFromRows(contract: ContractRow, ruleSet: RuleSetRow | null): HrRuleSet {
  if (ruleSet) {
    return {
      id: ruleSet.id,
      name: ruleSet.name,
      weekly_target_minutes: ruleSet.weekly_target_minutes,
      daily_target_minutes: ruleSet.daily_target_minutes,
      overtime_threshold_1_minutes: ruleSet.overtime_threshold_1_minutes,
      overtime_rate_1: toNum(ruleSet.overtime_rate_1),
      overtime_threshold_2_minutes: ruleSet.overtime_threshold_2_minutes,
      overtime_rate_2: toNum(ruleSet.overtime_rate_2),
      rounding_rule: parseRoundingRule(ruleSet.rounding_rule),
      break_rule: parseBreakRule(ruleSet.break_rule),
      active: ruleSet.active,
    };
  }
  const weekly = Math.round((toNum(contract.weekly_hours_target) ?? 0) * 60);
  const dailyRaw = toNum(contract.daily_hours_target);
  const daily = dailyRaw != null ? Math.round(dailyRaw * 60) : weekly > 0 ? Math.round(weekly / 5) : 0;
  return {
    id: `contract:${contract.id}`,
    name: `Dérivé du contrat (${contract.contract_type})`,
    weekly_target_minutes: weekly,
    daily_target_minutes: daily,
    overtime_threshold_1_minutes: weekly > 0 ? weekly : null, // HS au-delà de la cible contractuelle
    overtime_rate_1: 1.25,
    overtime_threshold_2_minutes: null,
    overtime_rate_2: null,
    rounding_rule: {},
    break_rule: {},
    active: true,
  };
}

// Arrondi du temps travaillé selon la règle (aucun si unit absent/0).
export function applyRounding(minutes: number, rule: RoundingRule): number {
  const unit = rule.unit_minutes ?? 0;
  if (!unit || unit <= 0) return Math.max(0, Math.round(minutes));
  const q = minutes / unit;
  const rounded = rule.mode === "up" ? Math.ceil(q) : rule.mode === "down" ? Math.floor(q) : Math.round(q);
  return Math.max(0, rounded * unit);
}

// Impose une pause minimale : au-delà de `auto_deduct_after_minutes` de travail, si la pause réelle est
// inférieure au minimum, le déficit est déduit du temps travaillé.
export function enforceMinimumBreak(workedMinutes: number, actualBreakMinutes: number, rule: BreakRule): number {
  const minB = rule.min_break_minutes ?? 0;
  const after = rule.auto_deduct_after_minutes ?? Number.POSITIVE_INFINITY;
  if (minB > 0 && workedMinutes >= after && actualBreakMinutes < minB) {
    return Math.max(0, workedMinutes - (minB - actualBreakMinutes));
  }
  return workedMinutes;
}

// Découpe le temps travaillé hebdo en normal / HS taux 1 (25) / HS taux 2 (50).
export function splitWeeklyOvertime(
  workedWeeklyMinutes: number,
  rule: Pick<HrRuleSet, "weekly_target_minutes" | "overtime_threshold_1_minutes" | "overtime_threshold_2_minutes">
): { normal: number; overtime25: number; overtime50: number } {
  const t1 = rule.overtime_threshold_1_minutes ?? rule.weekly_target_minutes;
  const t2 = rule.overtime_threshold_2_minutes ?? Number.POSITIVE_INFINITY;
  const w = Math.max(0, workedWeeklyMinutes);
  const normal = Math.min(w, t1);
  const overtime25 = Math.max(0, Math.min(w, t2) - t1);
  const overtime50 = Math.max(0, w - t2);
  return { normal, overtime25, overtime50 };
}

// Temps travaillé effectif d'une journée : pause minimale imposée puis arrondi.
export function effectiveDailyWorked(workedRaw: number, actualBreak: number, rule: HrRuleSet): number {
  return applyRounding(enforceMinimumBreak(workedRaw, actualBreak, rule.break_rule), rule.rounding_rule);
}

// Agrégat hebdomadaire selon la règle. Sans règle (aucun contrat) : tout à zéro (pas d'attendu à juger).
export function weeklyAggregate(
  workedWeekly: number,
  ruleSet: HrRuleSet | null
): {
  contract_minutes: number;
  overtime_25_minutes: number;
  overtime_50_minutes: number;
  absence_minutes: number;
  rule_set_name: string | null;
} {
  if (!ruleSet) {
    return { contract_minutes: 0, overtime_25_minutes: 0, overtime_50_minutes: 0, absence_minutes: 0, rule_set_name: null };
  }
  const split = splitWeeklyOvertime(workedWeekly, ruleSet);
  const contract = ruleSet.weekly_target_minutes;
  return {
    contract_minutes: contract,
    overtime_25_minutes: split.overtime25,
    overtime_50_minutes: split.overtime50,
    absence_minutes: contract > 0 ? Math.max(0, contract - workedWeekly) : 0,
    rule_set_name: ruleSet.name,
  };
}
