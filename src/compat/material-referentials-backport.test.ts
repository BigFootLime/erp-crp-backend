import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { query: mocks.query, connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })) },
}));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.headers.authorization) { res.status(401).json({ error: "Token manquant ou invalide" }); return; }
    req.user = { id: 7, username: "test", email: "test@example.test", role: "Operateur" };
    next();
  },
}));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import { augmentMaterialReferentialsAccessProfile, materialReferentialsBackportRouter } from "./material-referentials-backport";

function app() {
  const result = express();
  result.use(express.json());
  result.use("/stock", materialReferentialsBackportRouter);
  result.use("/auth", augmentMaterialReferentialsAccessProfile, (_req, res) => res.json({ modules: [{ module_key: "stock", allowed: false }, { module_key: "matiere-referentiels", allowed: false, nav_page_keys: ["wrong"] }] }));
  return result;
}

beforeEach(() => {
  mocks.query.mockReset(); mocks.clientQuery.mockReset(); mocks.release.mockReset(); mocks.audit.mockReset();
  mocks.audit.mockResolvedValue(null);
});

describe("material referentials backport", () => {
  it("accepts the same multi-standard Nuance identity as native Stock and returns its chosen title", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => String(sql).includes("INSERT INTO public.stock_nuances") ? { rows: [{ id: 11, code: "1-4404", is_active: true }] } : { rows: [] });
    mocks.query.mockResolvedValue({ rows: [{ id: 11, code: "1-4404", norme_werkstoff: "1.4404", norme_en: "EN-DEMO", designation_principale: "WERKSTOFF", densite: 8000, is_active: true }] });
    const response = await request(app()).post("/stock/matiere-nuances").set("Authorization", "Bearer test").send({ norme_en: "EN-DEMO", norme_werkstoff: "1.4404", designation_principale: "WERKSTOFF", densite: 8000 }).expect(201);
    expect(response.body).toMatchObject({ code: "1-4404", libelle: "1.4404", designation_principale: "WERKSTOFF", norme_en: "EN-DEMO", densite: 8000 });
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_nuances"))?.[1]).toEqual(["1-4404", "", 8, true, null, "EN-DEMO", "1.4404", null, "WERKSTOFF"]);
    expect(mocks.audit).toHaveBeenCalled();
  });

  it("rejects missing standards, empty selected titles and normalized conflicts in the compatibility route", async () => {
    const invalid = await request(app()).post("/stock/matiere-nuances").set("Authorization", "Bearer test").send({ code: "OLD" }).expect(400);
    expect(invalid.body).toEqual(expect.objectContaining({ error: expect.any(String), message: expect.any(String) }));
    await request(app()).post("/stock/matiere-nuances").set("Authorization", "Bearer test").send({ norme_usa: "USA-DEMO", designation_principale: "EN" }).expect(400);
    mocks.clientQuery.mockImplementation(async (sql: unknown) => { if (String(sql).includes("INSERT INTO public.stock_nuances")) throw Object.assign(new Error("duplicate"), { code: "23505" }); return { rows: [] }; });
    const duplicate = await request(app()).post("/stock/matiere-nuances").set("Authorization", "Bearer test").send({ norme_usa: "USA-DEMO" }).expect(409);
    expect(duplicate.body).toEqual(expect.objectContaining({ error: "DUPLICATE_REFERENTIAL_CODE", message: expect.any(String) }));
    expect(mocks.clientQuery).toHaveBeenCalledWith("ROLLBACK");
  });

  it("classifies a historical dotted code without renaming it or losing its old ID", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT to_jsonb")) return { rows: [{ row: { id: 12, code: "1.4404", designation_principale: "LEGACY" } }] };
      if (String(sql).includes("UPDATE public.stock_nuances")) return { rows: [{ id: 12, code: "1.4404", is_active: true }] };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [{ id: 12, code: "1.4404", norme_usa: "USA-DEMO", designation_principale: "USA", is_active: true }] });
    const response = await request(app()).patch("/stock/matiere-nuances/12").set("Authorization", "Bearer test").send({ code: "1.4404", norme_usa: "USA-DEMO", designation_principale: "USA" }).expect(200);
    expect(response.body).toMatchObject({ id: 12, code: "1.4404", libelle: "USA-DEMO" });
    const update = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_nuances"));
    expect(String(update?.[0])).not.toContain("code=");
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("n.norme_usa");
  });

  it("preserves legacy metadata and rejects classified renaming while locking before reading the row", async () => {
    let classified = false;
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT to_jsonb")) return { rows: [{ row: { id: 14, code: "OLD", designation_principale: classified ? "USA" : "LEGACY", ...(classified ? { norme_usa: "USA-DEMO" } : {}) } }] };
      if (String(sql).includes("UPDATE public.stock_nuances")) return { rows: [{ id: 14, code: "OLD", designation: "Updated", is_active: true }] };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [] });
    await request(app()).patch("/stock/matiere-nuances/14").set("Authorization", "Bearer test").send({ designation: "Updated" }).expect(200);
    const calls = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(calls.findIndex(sql => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(calls.findIndex(sql => sql.includes("FOR UPDATE")));
    expect(String(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_nuances"))?.[0])).not.toContain("norme_fr=");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.objectContaining({ query: mocks.clientQuery }) }));
    classified = true;
    await request(app()).patch("/stock/matiere-nuances/14").set("Authorization", "Bearer test").send({ code: "RENAMED" }).expect(400);
    expect(mocks.clientQuery).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("keeps the narrow surface authenticated", async () => {
    await request(app()).get("/stock/matiere-referential-capabilities").expect(401);
    await request(app()).get("/stock/matiere-referential-capabilities").set("Authorization", "Bearer test").expect(200, { read: true, write: true });
  });

  it("returns 404 for an authenticated patch of an unknown value", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => String(sql) === "BEGIN" || String(sql) === "ROLLBACK" ? { rows: [] } : { rows: [] });
    const missing = await request(app()).patch("/stock/matiere-nuances/99").set("Authorization", "Bearer test").send({ is_active: false }).expect(404);
    expect(missing.body).toEqual({ error: "NOT_FOUND", message: "Referential entry not found" });
  });

  it("normalizes duplicate writes to 409", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql) === "BEGIN" || String(sql) === "ROLLBACK") return { rows: [] };
      if (String(sql).includes("INSERT INTO public.stock_etats")) throw Object.assign(new Error("duplicate"), { code: "23505" });
      return { rows: [] };
    });
    await request(app()).post("/stock/matiere-etats").set("Authorization", "Bearer test").send({ code: "BRUT" }).expect(409);
  });

  it("accepts a code-only standalone sous-etat", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("INSERT INTO public.stock_sous_etats")) return { rows: [{ id: 8, code: "REC", designation: "", informations: "Pour une finition précise.", is_active: true }] };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [{ id: 8, etat_id: null, code: "REC", designation: "", informations: "Pour une finition précise.", is_active: true }] });
    const response = await request(app()).post("/stock/matiere-sous-etats").set("Authorization", "Bearer test").send({ code: "rec", informations: "Pour une finition précise." }).expect(201);
    expect(response.body).toMatchObject({ id: 8, code: "REC", designation: null, etat_id: null, informations: "Pour une finition précise." });
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_sous_etats"))?.[1]).toEqual([null, "REC", "", "Pour une finition précise.", true]);
  });

  it("accepts legacy inline relations and the old state purchase unit", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query) || query.includes("stock_nuance_etats")) return { rows: [] };
      if (query.includes("INSERT INTO public.stock_nuances")) return { rows: [{ id: 9, code: "S235", designation: "", is_active: true }] };
      if (query.includes("INSERT INTO public.stock_etats")) return { rows: [{ id: 10, code: "BRUT", designation: "", is_active: true }] };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [] });
    await request(app()).post("/stock/matiere-nuances").set("Authorization", "Bearer test").send({ code: "s235", norme_en: "S235", designation_principale: "EN", etat_ids: [4] }).expect(201);
    await request(app()).post("/stock/matiere-etats").set("Authorization", "Bearer test").send({ code: "brut", unite_achat: 12, nuance_ids: [9] }).expect(201);
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_nuances"))?.[1]).toEqual(["S235", "", null, true, null, "S235", null, null, "EN"]);
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_etats"))?.[1]).toEqual(["BRUT", "", 12, true]);
    expect(mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("stock_nuance_etats"))).toHaveLength(2);
  });

  it("filters lists by active state and rejects values beyond canonical field limits", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await request(app()).get("/stock/matiere-nuances?is_active=true&q=acier").set("Authorization", "Bearer test").expect(200, { items: [], total: 0 });
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("n.is_active=$2");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["%acier%", true]);
    const badRelation = await request(app()).get("/stock/matiere-sous-etats?etat_id=bad").set("Authorization", "Bearer test").expect(400);
    expect(badRelation.body).toEqual(expect.objectContaining({ error: "VALIDATION_ERROR", message: expect.any(String) }));
    await request(app()).post("/stock/matiere-sous-etats").set("Authorization", "Bearer test").send({ code: "X".repeat(41) }).expect(400);
    await request(app()).post("/stock/matiere-sous-etats").set("Authorization", "Bearer test").send({ code: "OK", designation: "X".repeat(161) }).expect(400);
    await request(app()).post("/stock/matiere-sous-etats").set("Authorization", "Bearer test").send({ code: "OK", informations: "X".repeat(10001) }).expect(400);
    await request(app()).post("/stock/matiere-etats").set("Authorization", "Bearer test").send({ code: "OK", informations: "Réservé aux sous-états" }).expect(400);
  });

  it("adds only the three virtual material grants to a successful profile", async () => {
    const response = await request(app()).get("/auth/access-profile").expect(200);
    expect(response.body.modules).toHaveLength(2);
    expect(response.body.modules[1]).toMatchObject({ module_key: "matiere-referentiels", allowed: true, nav_page_keys: ["matiere-nuances", "matiere-etats", "matiere-sous-etats"] });
  });
});
