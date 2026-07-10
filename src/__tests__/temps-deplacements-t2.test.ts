import { describe, expect, it } from "vitest";

import {
  detectTimeAnomalies,
  hashBadgeUid,
  hashDeviceToken,
  summarizeDay,
} from "../module/temps-deplacements/services/temps-deplacements.service";
import {
  isHrPrivileged,
  validateEmployeeAccess,
  validateManagerScope,
} from "../module/temps-deplacements/controllers/temps-deplacements.controller";
import {
  createTimeEventSchema,
  deviceEventSchema,
} from "../module/temps-deplacements/validators/temps-deplacements.validators";
import type { HrEmployeeLite, HrEventType, HrTimeEvent } from "../module/temps-deplacements/types/temps-deplacements.types";

function ev(type: HrEventType, time: string): HrTimeEvent {
  return { id: "e", employee_id: "emp", device_id: null, event_type: type, event_time: time, source: "WEB", created_at: time };
}
const T = (h: number, m = 0) => `2026-07-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`;
const emp = (over: Partial<HrEmployeeLite> = {}): HrEmployeeLite => ({
  id: "11111111-1111-4111-8111-111111111111",
  user_id: 1,
  matricule: "TD001",
  service: null,
  manager_user_id: null,
  status: "ACTIVE",
  ...over,
});

describe("T2 — summarizeDay (moteur journée, pur)", () => {
  it("IN/OUT normal → temps travaillé", () => {
    const r = summarizeDay([ev("IN", T(9)), ev("OUT", T(17))]);
    expect(r.firstIn).toBe(T(9));
    expect(r.lastOut).toBe(T(17));
    expect(r.breakMinutes).toBe(0);
    expect(r.workedMinutes).toBe(480);
    expect(r.openBreak).toBe(false);
  });
  it("pause complète déduite du temps travaillé", () => {
    const r = summarizeDay([ev("IN", T(9)), ev("BREAK_START", T(12)), ev("BREAK_END", T(13)), ev("OUT", T(17))]);
    expect(r.breakMinutes).toBe(60);
    expect(r.workedMinutes).toBe(420);
    expect(r.openBreak).toBe(false);
  });
  it("pause incomplète → openBreak, pas de temps de pause compté", () => {
    const r = summarizeDay([ev("IN", T(9)), ev("BREAK_START", T(12)), ev("OUT", T(17))]);
    expect(r.openBreak).toBe(true);
    expect(r.breakMinutes).toBe(0);
    expect(r.workedMinutes).toBe(480);
  });
  it("entrée sans sortie → 0 minute travaillée (session ouverte)", () => {
    const r = summarizeDay([ev("IN", T(9))]);
    expect(r.lastOut).toBeNull();
    expect(r.workedMinutes).toBe(0);
  });
});

describe("T2 — detectTimeAnomalies", () => {
  it("sortie sans entrée → MISSING_IN", () => {
    const a = detectTimeAnomalies([ev("OUT", T(17))], { openBreak: false, workedMinutes: 0, totalBreak: 0, isPastDay: true });
    expect(a.map((x) => x.anomaly_type)).toContain("MISSING_IN");
  });
  it("entrée sans sortie sur jour PASSÉ → MISSING_OUT", () => {
    const a = detectTimeAnomalies([ev("IN", T(9))], { openBreak: false, workedMinutes: 0, totalBreak: 0, isPastDay: true });
    expect(a.map((x) => x.anomaly_type)).toContain("MISSING_OUT");
  });
  it("entrée sans sortie AUJOURD'HUI → aucune anomalie (session en cours)", () => {
    const a = detectTimeAnomalies([ev("IN", T(9))], { openBreak: false, workedMinutes: 0, totalBreak: 0, isPastDay: false });
    expect(a.map((x) => x.anomaly_type)).not.toContain("MISSING_OUT");
  });
  it("pause non terminée jour passé → MISSING_BREAK_END", () => {
    const a = detectTimeAnomalies([ev("IN", T(9)), ev("BREAK_START", T(12))], { openBreak: true, workedMinutes: 480, totalBreak: 0, isPastDay: true });
    expect(a.map((x) => x.anomaly_type)).toContain("MISSING_BREAK_END");
  });
  it("journée > 12h → TOO_LONG_DAY", () => {
    const a = detectTimeAnomalies([ev("IN", T(6)), ev("OUT", T(22))], { openBreak: false, workedMinutes: 13 * 60, totalBreak: 0, isPastDay: true });
    expect(a.map((x) => x.anomaly_type)).toContain("TOO_LONG_DAY");
  });
});

describe("T2 — hachage badge/token (jamais en clair)", () => {
  it("badge UID haché en sha256 hex, ≠ clair, déterministe", () => {
    const h = hashBadgeUid("04AABBCCDD");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe("04AABBCCDD");
    expect(hashBadgeUid("04AABBCCDD")).toBe(h);
    expect(hashBadgeUid("other")).not.toBe(h);
  });
  it("device token haché aussi", () => {
    expect(hashDeviceToken("secret-token")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken("secret-token")).not.toBe("secret-token");
  });
});

describe("T2 — validateurs (anti-IDOR structurel + idempotency)", () => {
  it("createTimeEventSchema accepte {event_type} et REFUSE tout employee_id", () => {
    expect(createTimeEventSchema.parse({ event_type: "IN" }).event_type).toBe("IN");
    expect(() => createTimeEventSchema.parse({ event_type: "IN", employee_id: "x" })).toThrow();
    expect(() => createTimeEventSchema.parse({ event_type: "NOPE" })).toThrow();
  });
  it("deviceEventSchema EXIGE idempotency_key (min 8)", () => {
    expect(() => deviceEventSchema.parse({ badge_uid: "abc", event_type: "IN" })).toThrow();
    expect(() => deviceEventSchema.parse({ badge_uid: "abc", event_type: "IN", idempotency_key: "short" })).toThrow();
    expect(deviceEventSchema.parse({ badge_uid: "abc", event_type: "IN", idempotency_key: "abcd1234" }).idempotency_key).toBe("abcd1234");
  });
});

describe("T2 — RBAC / anti-IDOR", () => {
  it("un salarié accède à SES données", () => {
    expect(() => validateEmployeeAccess({ id: 1, role: "Employee" }, emp({ user_id: 1 }))).not.toThrow();
  });
  it("un salarié NE PEUT PAS lire un autre salarié (403)", () => {
    expect(() => validateEmployeeAccess({ id: 2, role: "Employee" }, emp({ user_id: 1, manager_user_id: null }))).toThrow();
  });
  it("un manager accède à son subordonné", () => {
    expect(() => validateEmployeeAccess({ id: 5, role: "Employee" }, emp({ user_id: 1, manager_user_id: 5 }))).not.toThrow();
    expect(validateManagerScope({ id: 5, role: "Employee" }, emp({ manager_user_id: 5 }))).toBe(true);
  });
  it("Responsable RH / Direction / Admin accèdent globalement", () => {
    expect(isHrPrivileged("Responsable RH")).toBe(true);
    expect(isHrPrivileged("Directeur")).toBe(true);
    expect(isHrPrivileged("Administrateur Systeme et Reseau")).toBe(true);
    expect(isHrPrivileged("Employee")).toBe(false);
    expect(() => validateEmployeeAccess({ id: 9, role: "Responsable RH" }, emp({ user_id: 1 }))).not.toThrow();
  });
});
