import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";

const state = vi.hoisted(() => ({ rows: new Map<number, unknown>(), query: vi.fn(), active: vi.fn() }));
vi.mock("../config/database", () => ({ default: { query: state.query, on: vi.fn() } }));
vi.mock("../module/auth/repository/auth.repository", () => ({ findAuthenticatedAccountState: state.active }));
import authRoutes from "../module/auth/routes/auth.routes";
import { defaultNavigationPreferences } from "../module/auth/validators/navigation-preferences.validators";

const app = express();
app.use(express.json());
app.use("/auth", authRoutes);
app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err instanceof ZodError ? 400 : err.status ?? 500).json({ error: err.name });
});
const endpoint = "/auth/me/navigation-preferences";
const bearer = (id: number) => `Bearer ${jwt.sign({ id, username: `fixture-${id}`, role: "Opérateur", session_epoch: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;
beforeEach(() => {
  process.env.JWT_SECRET = "navigation-preferences-unit-tests-only";
  state.rows.clear(); state.query.mockReset(); state.active.mockReset();
  state.active.mockResolvedValue({ status: "Active", session_epoch: 0, mfa_required: false });
  state.query.mockImplementation(async (sql: string, params: unknown[]) => {
    const userId = Number(params[0]);
    if (sql.startsWith("INSERT")) state.rows.set(userId, JSON.parse(String(params[1])));
    return { rows: state.rows.has(userId) ? [{ preferences: state.rows.get(userId) }] : [] };
  });
});
describe("own-account navigation preferences HTTP contract", () => {
  it("requires an active, authenticated session for both methods", async () => {
    await request(app).get(endpoint).expect(401);
    await request(app).put(endpoint).send(defaultNavigationPreferences()).expect(401);
    state.active.mockResolvedValueOnce({ status: "Inactive" });
    await request(app).get(endpoint).set("Authorization", bearer(1)).expect(403);
    expect(state.query).not.toHaveBeenCalled();
  });
  it("returns classic left defaults to an operator without creating data on GET", async () => {
    const res = await request(app).get(endpoint).set("Authorization", bearer(1)).expect(200);
    expect(res.body).toEqual(defaultNavigationPreferences());
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(state.rows.size).toBe(0);
  });
  it("persists a full configuration across sessions without mixing owners", async () => {
    const preferences = defaultNavigationPreferences(); preferences.side = "right"; preferences.activeView = "global";
    preferences.views.global.favoritePageKeys = ["devis"];
    await request(app).put(endpoint).set("Authorization", bearer(1)).send(preferences).expect(200);
    expect((await request(app).get(endpoint).set("Authorization", bearer(1))).body).toEqual(preferences);
    expect((await request(app).get(endpoint).set("Authorization", bearer(2))).body).toEqual(defaultNavigationPreferences());
    expect((await request(app).get(`${endpoint}?user_id=1`).set("Authorization", bearer(2))).body).toEqual(defaultNavigationPreferences());
  });
  it("rejects ownership fields and malformed preferences before SQL", async () => {
    const p = defaultNavigationPreferences();
    for (const body of [{ ...p, user_id: 2 }, { ...p, side: "top" }, { ...p, schemaVersion: 0 }, { ...p, views: {} }]) {
      await request(app).put(endpoint).set("Authorization", bearer(1)).send(body).expect(400);
    }
    p.views.current.favoritePageKeys = ["devis", "devis"];
    await request(app).put(endpoint).set("Authorization", bearer(1)).send(p).expect(400);
    p.views.current.favoritePageKeys = ["https://example.com"];
    await request(app).put(endpoint).set("Authorization", bearer(1)).send(p).expect(400);
    expect(state.query).not.toHaveBeenCalled();
  });
  it("uses one atomic upsert and the last successful save wins", async () => {
    const a = defaultNavigationPreferences(); a.side = "right";
    const b = defaultNavigationPreferences(); b.activeView = "production";
    await request(app).put(endpoint).set("Authorization", bearer(1)).send(a).expect(200);
    await request(app).put(endpoint).set("Authorization", bearer(1)).send(b).expect(200);
    expect(state.rows.get(1)).toEqual(b);
    expect(state.query.mock.calls.every(([sql]) => sql.includes("ON CONFLICT (user_id) DO UPDATE"))).toBe(true);
  });
  it("reports database and stored-schema failures instead of presenting a saveable default", async () => {
    state.query.mockRejectedValueOnce(new Error("unavailable"));
    await request(app).get(endpoint).set("Authorization", bearer(1)).expect(500);
    state.rows.set(1, { schemaVersion: 2 });
    await request(app).get(endpoint).set("Authorization", bearer(1)).expect(503);
    expect(state.rows.get(1)).toEqual({ schemaVersion: 2 });
  });
});
