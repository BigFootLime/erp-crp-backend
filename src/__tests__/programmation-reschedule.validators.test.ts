import { describe, expect, it } from "vitest";

import {
  cancelProgrammationRescheduleSchema,
  commitProgrammationRescheduleSchema,
  previewProgrammationRescheduleSchema,
} from "../module/programmation/validators/programmation.validators";

const candidate = {
  start_date: "2026-08-10",
  end_date: "2026-08-12",
  programmer_user_id: 7,
  machine_id: null,
  poste_id: null,
  calendar_id: null,
};

describe("programmation safe-reschedule validators", () => {
  it("accepts a strict offset-independent calendar-date preview", () => {
    const parsed = previewProgrammationRescheduleSchema.parse({
      body: {
        expected_version: 3,
        reason: "Priorité client confirmée",
        timezone: "Europe/Paris",
        source: "KEYBOARD",
        candidate,
      },
    });
    expect(parsed.body.candidate).toEqual(candidate);
  });

  it.each(["2026-02-30", "08/10/2026", "2026-8-1", "2026-08-10T00:00:00Z"])(
    "rejects ambiguous or impossible date %s",
    (start_date) => {
      expect(() => previewProgrammationRescheduleSchema.parse({
        body: {
          expected_version: 1,
          reason: "Motif valide",
          timezone: "Europe/Paris",
          source: "API",
          candidate: { ...candidate, start_date },
        },
      })).toThrow();
    },
  );

  it("rejects an inverted or unbounded interval", () => {
    for (const dates of [
      { start_date: "2026-08-12", end_date: "2026-08-10" },
      { start_date: "2026-01-01", end_date: "2027-12-31" },
    ]) {
      expect(() => previewProgrammationRescheduleSchema.parse({
        body: {
          expected_version: 1,
          reason: "Motif valide",
          timezone: "Europe/Paris",
          source: "API",
          candidate: { ...candidate, ...dates },
        },
      })).toThrow();
    }
  });

  it("requires an IANA timezone, a useful reason and positive version", () => {
    for (const patch of [
      { timezone: "Paris", reason: "Motif valide", expected_version: 1 },
      { timezone: "Europe/Paris", reason: "non", expected_version: 1 },
      { timezone: "Europe/Paris", reason: "Motif valide", expected_version: 0 },
    ]) {
      expect(() => previewProgrammationRescheduleSchema.parse({
        body: { ...patch, source: "API", candidate },
      })).toThrow();
    }
  });

  it("rejects unknown fields instead of trusting renderer-only state", () => {
    expect(() => previewProgrammationRescheduleSchema.parse({
      body: {
        expected_version: 1,
        reason: "Motif valide",
        timezone: "Europe/Paris",
        source: "API",
        candidate: { ...candidate, allow_overlap: true },
      },
    })).toThrow();
  });

  it("binds commit to a preview token and bounded idempotency key", () => {
    const parsed = commitProgrammationRescheduleSchema.parse({
      body: {
        expected_version: 1,
        reason: "Motif de déplacement",
        timezone: "Europe/Paris",
        source: "POINTER",
        candidate,
        idempotency_key: "drop:12345678",
        preview_token: "a".repeat(64),
      },
    });
    expect(parsed.body.idempotency_key).toBe("drop:12345678");
    expect(() => commitProgrammationRescheduleSchema.parse({
      body: { ...parsed.body, idempotency_key: "bad key" },
    })).toThrow();
  });

  it("requires an independent cancellation intention", () => {
    const parsed = cancelProgrammationRescheduleSchema.parse({
      body: {
        expected_version: 2,
        reason: "Annulation compensée après erreur",
        timezone: "Europe/Paris",
        source: "TOUCH",
        idempotency_key: "cancel:12345678",
      },
    });
    expect(parsed.body.source).toBe("TOUCH");
  });
});
