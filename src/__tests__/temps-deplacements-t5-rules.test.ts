import { describe, expect, it } from "vitest";
import {
  applyRounding,
  effectiveRuleSetFromRows,
  enforceMinimumBreak,
  splitWeeklyOvertime,
  weeklyAggregate,
  type ContractRow,
  type HrRuleSet,
} from "../module/temps-deplacements/services/temps-deplacements-rules";

const rs = (over: Partial<HrRuleSet> = {}): HrRuleSet => ({
  id: "r", name: "R", weekly_target_minutes: 2100, daily_target_minutes: 420,
  overtime_threshold_1_minutes: 2100, overtime_rate_1: 1.25, overtime_threshold_2_minutes: 2580, overtime_rate_2: 1.5,
  rounding_rule: {}, break_rule: {}, active: true, ...over,
});

// 35h = 2100 min, 39h = 2340 min, 43h = 2580 min. AUCUNE de ces valeurs n'est codée dans le moteur.
describe("T5 — weeklyAggregate (35h/39h/HS/absence, règles configurables)", () => {
  it("salarié 35h semaine normale → aucune HS, aucune absence", () => {
    const a = weeklyAggregate(2100, rs({ weekly_target_minutes: 2100, overtime_threshold_1_minutes: 2100 }));
    expect(a).toMatchObject({ contract_minutes: 2100, overtime_25_minutes: 0, overtime_50_minutes: 0, absence_minutes: 0 });
  });
  it("salarié 39h semaine normale → aucune HS (seuil = contrat)", () => {
    const a = weeklyAggregate(2340, rs({ weekly_target_minutes: 2340, overtime_threshold_1_minutes: 2340 }));
    expect(a).toMatchObject({ contract_minutes: 2340, overtime_25_minutes: 0, overtime_50_minutes: 0 });
  });
  it("temps partiel 20h → cible 1200, HS au-delà", () => {
    expect(weeklyAggregate(1200, rs({ weekly_target_minutes: 1200, overtime_threshold_1_minutes: 1200, overtime_threshold_2_minutes: null })))
      .toMatchObject({ overtime_25_minutes: 0, absence_minutes: 0 });
    expect(weeklyAggregate(1320, rs({ weekly_target_minutes: 1200, overtime_threshold_1_minutes: 1200, overtime_threshold_2_minutes: null })).overtime_25_minutes).toBe(120);
  });
  it("heures sup 25 (base 35h) : 40h → 300 min à 25 %, 0 à 50 %", () => {
    const a = weeklyAggregate(2400, rs());
    expect(a.overtime_25_minutes).toBe(300);
    expect(a.overtime_50_minutes).toBe(0);
  });
  it("heures sup 50 : 45h → 480 min à 25 % puis 120 min à 50 %", () => {
    const a = weeklyAggregate(2700, rs());
    expect(a.overtime_25_minutes).toBe(2580 - 2100);
    expect(a.overtime_50_minutes).toBe(2700 - 2580);
  });
  it("absence : 30h sur contrat 35h → 300 min d'absence", () => {
    expect(weeklyAggregate(1800, rs()).absence_minutes).toBe(300);
  });
  it("absence de contrat (règle nulle) → tout à zéro, pas de plantage", () => {
    expect(weeklyAggregate(2000, null)).toEqual({ contract_minutes: 0, overtime_25_minutes: 0, overtime_50_minutes: 0, absence_minutes: 0, rule_set_name: null });
  });
});

describe("T5 — splitWeeklyOvertime (bornes)", () => {
  it("t2 non défini → tout le sup passe en taux 1", () => {
    expect(splitWeeklyOvertime(2600, rs({ overtime_threshold_2_minutes: null }))).toEqual({ normal: 2100, overtime25: 500, overtime50: 0 });
  });
});

describe("T5 — effectiveRuleSetFromRows (contrat vs rule_set, changement de contrat)", () => {
  const ct = (over: Partial<ContractRow>): ContractRow => ({ id: "c", contract_type: "H35", weekly_hours_target: 35, daily_hours_target: null, rule_set_id: null, ...over });
  it("sans rule_set : cible dérivée du CONTRAT (jamais 35/39 en dur)", () => {
    const r = effectiveRuleSetFromRows(ct({ weekly_hours_target: 35 }), null);
    expect(r.weekly_target_minutes).toBe(2100);
    expect(r.daily_target_minutes).toBe(420); // 2100/5
    expect(r.overtime_threshold_1_minutes).toBe(2100);
  });
  it("changement de contrat 35h → 39h : cibles différentes", () => {
    const r35 = effectiveRuleSetFromRows(ct({ weekly_hours_target: 35 }), null);
    const r39 = effectiveRuleSetFromRows(ct({ contract_type: "H39", weekly_hours_target: 39 }), null);
    expect(r39.weekly_target_minutes).toBe(2340);
    expect(r39.weekly_target_minutes).not.toBe(r35.weekly_target_minutes);
  });
  it("avec rule_set : les cibles du rule_set priment sur le contrat", () => {
    const r = effectiveRuleSetFromRows(ct({ weekly_hours_target: 39, rule_set_id: "rs1" }), {
      id: "rs1", name: "Cadre 35h", weekly_target_minutes: 2100, daily_target_minutes: 420,
      overtime_threshold_1_minutes: 2100, overtime_rate_1: 1.25, overtime_threshold_2_minutes: 2580, overtime_rate_2: 1.5,
      rounding_rule: { unit_minutes: 15, mode: "nearest" }, break_rule: { min_break_minutes: 20 }, active: true,
    });
    expect(r.weekly_target_minutes).toBe(2100); // rule_set, pas 2340
    expect(r.rounding_rule.unit_minutes).toBe(15);
    expect(r.break_rule.min_break_minutes).toBe(20);
  });
});

describe("T5 — arrondis & pause minimale", () => {
  it("arrondi au quart d'heure (nearest/up/down)", () => {
    expect(applyRounding(127, { unit_minutes: 15, mode: "nearest" })).toBe(120);
    expect(applyRounding(121, { unit_minutes: 15, mode: "up" })).toBe(135);
    expect(applyRounding(134, { unit_minutes: 15, mode: "down" })).toBe(120);
    expect(applyRounding(127, {})).toBe(127); // pas de règle → inchangé
  });
  it("pause minimale imposée au-delà d'un seuil", () => {
    expect(enforceMinimumBreak(480, 10, { min_break_minutes: 30, auto_deduct_after_minutes: 360 })).toBe(460); // déduit 20
    expect(enforceMinimumBreak(300, 0, { min_break_minutes: 30, auto_deduct_after_minutes: 360 })).toBe(300); // sous le seuil
    expect(enforceMinimumBreak(480, 30, { min_break_minutes: 30, auto_deduct_after_minutes: 360 })).toBe(480); // pause suffisante
  });
});
