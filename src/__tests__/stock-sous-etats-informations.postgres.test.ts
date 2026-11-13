import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.CERP_SUBSTATE_INFORMATION_PG_URL;
if (url && (process.env.CERP_E2E_ISOLATED !== "1" || new URL(url).pathname !== "/stock_sous_etats_informations")) {
  throw new Error("Sub-state information migration tests require the named disposable database");
}

describe.skipIf(!url)("sub-state information migration — real isolated PostgreSQL", () => {
  const db = new Pool({ connectionString: url, max: 1 });
  const patchPath = path.resolve(process.cwd(), "db/patches/20261112_stock_sous_etats_informations.sql");

  beforeAll(async () => {
    expect((await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name).toBe("stock_sous_etats_informations");
    await db.query("CREATE TABLE public.stock_sous_etats (id bigint PRIMARY KEY, code text NOT NULL, designation text NOT NULL, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now())");
    await db.query("INSERT INTO public.stock_sous_etats (id, code, designation) VALUES (1, 'LEGACY', 'Valeur existante')");
    const patch = await readFile(patchPath, "utf8");
    await db.query(patch);
    await db.query(patch);
  });

  afterAll(async () => { await db.end(); });

  it("is repeatable, preserves existing rows, stores multiline text and rejects oversized information", async () => {
    expect((await db.query<{ informations: string | null }>("SELECT informations FROM public.stock_sous_etats WHERE id=1")).rows[0]?.informations).toBeNull();
    const paragraph = "Première ligne.\nDeuxième ligne.";
    await db.query("UPDATE public.stock_sous_etats SET informations=$1 WHERE id=1", [paragraph]);
    expect((await db.query<{ informations: string }>("SELECT informations FROM public.stock_sous_etats WHERE id=1")).rows[0]?.informations).toBe(paragraph);
    await expect(db.query("UPDATE public.stock_sous_etats SET informations=$1 WHERE id=1", ["X".repeat(10_001)])).rejects.toMatchObject({ code: "23514" });
  });
});
