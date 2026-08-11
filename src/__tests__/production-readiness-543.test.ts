import fs from "node:fs";
import path from "node:path";

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/production-readiness/repository/production-readiness.repository", () => ({
  repoReadProductionPrerequisites: vi.fn(async () => [
    {
      prerequisite_code: "ACTIVE_PRODUCTION_CALENDAR",
      ready: false,
      definition: "Calendrier explicite",
      unit: "minutes d'ouverture par jour",
      period_start: null,
      period_end: null,
      source: "public.programmation_calendars",
      freshness_at: null,
      reliability: "DECLARED",
      actual_value: { active_calendars: 0 },
      expected_value: "au moins 1",
      remediation: "Configurer le calendrier",
    },
  ]),
  repoListProductionCalendars: vi.fn(async () => []),
  repoCreateProductionCalendar: vi.fn(async (input) => ({
    created: true,
    calendar: {
      id: "31000000-0000-4000-8000-000000000001",
      ...input,
      created_at: "2026-08-11T10:00:00.000Z",
      updated_at: "2026-08-11T10:00:00.000Z",
      created_by: 1,
      updated_by: 1,
      closures: [],
    },
  })),
  repoUpdateProductionCalendar: vi.fn(),
  repoCreateCalendarClosure: vi.fn(),
  repoDeleteCalendarClosure: vi.fn(),
}));

import productionReadinessRoutes from "../module/production-readiness/routes/production-readiness.routes";
import {
  productionReadinessCapabilitiesFor,
  roleHasProductionReadinessCapability,
} from "../module/production-readiness/domain/production-readiness-policy";
import { productionCalendarSchema } from "../module/production-readiness/validators/production-readiness.validators";
import { addCostCenterRateSchema } from "../module/methodes/validators/methodes.validators";

function testApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) req.user = { id: 1, username: "test", email: "test@example.test", role };
    next();
  });
  app.use("/production/readiness", productionReadinessRoutes);
  app.use((error: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 400).json({ code: error.code ?? "VALIDATION_ERROR", message: error.message });
  });
  return app;
}

afterEach(() => vi.clearAllMocks());

describe("SOL-06 production readiness policy", () => {
  it("allows operators to understand blockers but never to configure calendars", () => {
    expect(roleHasProductionReadinessCapability("Opérateur atelier", "view")).toBe(true);
    expect(roleHasProductionReadinessCapability("Opérateur atelier", "calendar_write")).toBe(false);
  });

  it("keeps calendar and financial rate permissions separate", () => {
    expect(productionReadinessCapabilitiesFor("Responsable Programmation")).toMatchObject({
      view: true,
      calendar_write: true,
      rate_write: false,
    });
    expect(productionReadinessCapabilitiesFor("Comptabilite")).toMatchObject({
      calendar_write: false,
      rate_write: true,
    });
  });

  it("rejects implicit 24-hour calendars and missing working days", () => {
    expect(
      productionCalendarSchema.safeParse({
        code: "ATELIER",
        label: "Atelier principal",
        timezone: "Europe/Paris",
        working_days: [],
        day_start: "08:00",
        day_end: "08:00",
        active: true,
      }).success
    ).toBe(false);
  });

  it("rejects a zero hourly rate instead of treating unknown cost as free", () => {
    expect(
      addCostCenterRateSchema.safeParse({
        taux_horaire: 0,
        date_effet: "2026-08-11",
        source: "Décision de gestion",
      }).success
    ).toBe(false);
  });
});

describe("SOL-06 production readiness HTTP boundary", () => {
  it("rejects anonymous access", async () => {
    await request(testApp()).get("/production/readiness").expect(401);
  });

  it("returns actionable metadata to an operator without management rights", async () => {
    const response = await request(testApp())
      .get("/production/readiness")
      .set("x-test-role", "Opérateur atelier")
      .expect(200);
    expect(response.body.ready).toBe(false);
    expect(response.body.prerequisites[0]).toMatchObject({
      action_path: "/planning/parametres/calendriers",
      can_manage: false,
      reliability: "DECLARED",
    });
  });

  it("denies calendar creation to an operator", async () => {
    await request(testApp())
      .post("/production/readiness/calendars")
      .set("x-test-role", "Opérateur atelier")
      .send({})
      .expect(403);
  });

  it("lets an administrator create only an explicit calendar", async () => {
    const response = await request(testApp())
      .post("/production/readiness/calendars")
      .set("x-test-role", "Administrateur")
      .send({
        code: "ATELIER",
        label: "Atelier principal",
        timezone: "Europe/Paris",
        working_days: [1, 2, 3, 4, 5],
        day_start: "08:00",
        day_end: "17:00",
        active: true,
      })
      .expect(201);
    expect(response.body).toMatchObject({ code: "ATELIER", replayed: false });
  });
});

describe("SOL-06 migration contract", () => {
  const root = path.resolve(__dirname, "..", "..");
  const migration = fs.readFileSync(path.join(root, "db/patches/20260811_production_readiness_center.sql"), "utf8");
  const preflight = fs.readFileSync(
    path.join(root, "db/patches/support/20260811_production_readiness_center.preflight.sql"),
    "utf8"
  );

  it("requires positive rates and a non-zero explicit work window", () => {
    expect(migration).toContain("rate.taux_horaire > 0");
    expect(migration).toContain("calendar.day_start < calendar.day_end");
    expect(migration).toContain("'DECLARED'::text AS reliability");
  });

  it("does not make missing business values an installation blocker", () => {
    expect(preflight).not.toMatch(/RAISE EXCEPTION[^;]+no active production calendar/i);
    expect(preflight).not.toMatch(/RAISE EXCEPTION[^;]+hourly rate/i);
  });
});
