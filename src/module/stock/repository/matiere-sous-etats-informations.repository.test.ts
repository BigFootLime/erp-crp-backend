import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.query, connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })) },
}));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import {
  repoCreateMatiereSousEtat,
  repoListMatiereSousEtats,
  repoUpdateMatiereSousEtat,
  type AuditContext,
} from "./stock.repository";
import { updateMatiereSousEtatSchema } from "../validators/stock.validators";

const audit: AuditContext = {
  user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null,
  path: "/api/v1/stock/matiere-sous-etats", page_key: "matiere-sous-etats", client_session_id: null,
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
  mocks.release.mockReset();
  mocks.audit.mockReset();
  mocks.audit.mockResolvedValue(null);
});

describe("material sub-state information repository", () => {
  it("stores the trimmed optional paragraph and exposes it in lists", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("INSERT INTO public.stock_sous_etats")) {
        return { rows: [{ id: 21, etat_id: null, code: "RECT", designation: "", informations: "Rectification précise.", is_active: true }] };
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });
    mocks.query.mockResolvedValue({ rows: [{ id: 21, etat_id: null, code: "RECT", designation: "", informations: "Rectification précise.", is_active: true }] });

    const created = await repoCreateMatiereSousEtat({ code: "RECT", designation: null, informations: "  Rectification précise.  ", is_active: true }, audit);
    const listed = await repoListMatiereSousEtats({});

    expect(created.informations).toBe("Rectification précise.");
    expect(listed[0]?.informations).toBe("Rectification précise.");
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_sous_etats"))?.[1])
      .toEqual([null, "RECT", "", "Rectification précise.", true]);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("se.informations");
  });

  it("clears information explicitly without changing the state-independent association", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("FOR UPDATE")) return { rows: [{ row: { id: 21, etat_id: null, code: "RECT", informations: "Ancienne précision" } }] };
      if (query.startsWith("UPDATE public.stock_sous_etats")) return { rows: [] };
      if (query.includes("SELECT id::int AS id, etat_id::int AS etat_id, code, designation, informations, is_active")) {
        return { rows: [{ id: 21, etat_id: null, code: "RECT", designation: "", informations: null, is_active: true }] };
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const body = updateMatiereSousEtatSchema.parse({ body: { informations: null } }).body;
    const updated = await repoUpdateMatiereSousEtat(21, body, audit);

    expect(updated).toMatchObject({ id: 21, etat_id: null, informations: null });
    const update = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE public.stock_sous_etats"));
    expect(String(update?.[0])).toContain("informations = $2");
    expect(update?.[1]).toEqual([21, null]);
  });
});
