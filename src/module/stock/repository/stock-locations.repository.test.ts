import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));
const insertAuditLog = vi.hoisted(() => vi.fn());

vi.mock("../../../config/database", () => ({ default: database }));
vi.mock("./stock-persistence.repository", () => ({
  insertAuditLog,
  isPgUniqueViolation: () => false,
}));

import {
  repoCreateEmplacement,
  repoListEmplacements,
  repoUpdateEmplacement,
} from "./stock-locations.repository";

describe("stock locations owner", () => {
  it("keeps all location declarations in the owner and the facade as compatibility-only re-exports", () => {
    const ownerPath = path.join(__dirname, "stock-locations.repository.ts");
    const facadePath = path.join(__dirname, "stock.repository.ts");
    const owner = ts.createSourceFile(ownerPath, readFileSync(ownerPath, "utf8"), ts.ScriptTarget.Latest, true);
    const facade = readFileSync(facadePath, "utf8");
    const expected = new Set([
      "repoListMagasins",
      "repoGetMagasin",
      "repoGetMagasinsKpis",
      "repoCreateMagasin",
      "repoUpdateMagasin",
      "repoDeactivateMagasin",
      "repoActivateMagasin",
      "repoListEmplacements",
      "repoCreateEmplacement",
      "repoUpdateEmplacement",
    ]);
    const declared = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(owner);

    expect([...expected].every((name) => declared.has(name))).toBe(true);
    expect(owner.statements.some((statement) =>
      ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === "./stock.repository"
    )).toBe(false);
    expect([...expected].every((name) => new RegExp(`export async function ${name}`).test(facade))).toBe(false);
    expect(facade).toContain('} from "./stock-locations.repository";');
  });

  it("preserves emplacement pagination, filtering and requested query order", async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ total: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 12, code: "A-01" }] });

    await expect(
      repoListEmplacements({
        page: 2,
        pageSize: 3,
        q: "A_%",
        sortBy: "code",
        sortDir: "asc",
      })
    ).resolves.toEqual({ items: [{ id: 12, code: "A-01" }], total: 7 });

    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM public.emplacements e JOIN public.magasins m"),
      ["%A_%%"]
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY e.code ASC"),
      ["%A_%%", 3, 3]
    );
  });

  it("rolls back a locked emplacement update when its write fails", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{ is_scrap: false, location_type: "STORAGE", allow_outbound: true }],
        })
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    database.connect.mockResolvedValueOnce(client);

    await expect(
      repoUpdateEmplacement(
        12,
        { name: "Nouveau nom" },
        {
          user_id: 7,
          ip: null,
          user_agent: null,
          device_type: null,
          os: null,
          browser: null,
          path: null,
          page_key: null,
          client_session_id: null,
        }
      )
    ).rejects.toThrow("write failed");

    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining("FOR UPDATE"), [12]);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  it("rolls back and releases a create transaction when the locked magasin is absent", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    database.connect.mockResolvedValueOnce(client);

    await expect(
      repoCreateEmplacement(
        "11111111-1111-1111-1111-111111111111",
        {
          code: "A-01",
          is_scrap: false,
          is_active: true,
          location_type: "STORAGE",
          allow_inbound: true,
          allow_outbound: true,
          restrictions: {},
        },
        {
          user_id: 7,
          ip: null,
          user_agent: null,
          device_type: null,
          os: null,
          browser: null,
          path: null,
          page_key: null,
          client_session_id: null,
        }
      )
    ).resolves.toBeNull();

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM public.magasins"),
      ["11111111-1111-1111-1111-111111111111"]
    );
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  it("audits and commits an update after retaining the emplacement lock", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{ is_scrap: false, location_type: "STORAGE", allow_outbound: true }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{ id: 12, code: "A-01", name: "Nouveau nom" }],
        })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    database.connect.mockResolvedValueOnce(client);
    insertAuditLog.mockResolvedValueOnce(undefined);

    await expect(
      repoUpdateEmplacement(
        12,
        { name: "Nouveau nom" },
        {
          user_id: 7,
          ip: null,
          user_agent: null,
          device_type: null,
          os: null,
          browser: null,
          path: null,
          page_key: null,
          client_session_id: null,
        }
      )
    ).resolves.toEqual({ id: 12, code: "A-01", name: "Nouveau nom" });

    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining("FOR UPDATE"), [12]);
    expect(insertAuditLog).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ user_id: 7 }),
      expect.objectContaining({ action: "stock.emplacements.update", entity_id: "12" })
    );
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
