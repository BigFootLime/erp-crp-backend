import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readCommandeDuplicateLinesTx } from "../module/commande-client/repository/commande-duplicate-lines.repository";

const url = process.env.COMMANDE_DUPLICATE_1116_TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;
let pool: Pool;

describePg("duplicate order civil dates — PostgreSQL #1116", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Explicit isolated database URLs must match");
    const target = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/cerp_commande_duplicate_dates_1116_test") {
      throw new Error("Only the owned disposable loopback database is allowed");
    }
    pool = new Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE TABLE public.commande_ligne (
      id BIGSERIAL PRIMARY KEY, commande_id BIGINT NOT NULL,
      designation TEXT NOT NULL, code_piece TEXT, article_id UUID, piece_technique_id UUID,
      source_article_devis_id UUID, source_dossier_devis_id UUID,
      quantite NUMERIC NOT NULL, unite TEXT, prix_unitaire_ht NUMERIC NOT NULL,
      remise_ligne NUMERIC, taux_tva NUMERIC, delai_client DATE, delai_interne DATE,
      devis_numero TEXT, famille TEXT
    );
    CREATE TABLE public.duplicate_date_copy (commande_id BIGINT PRIMARY KEY, client_due DATE, internal_due DATE);`);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE public.commande_ligne, public.duplicate_date_copy RESTART IDENTITY");
    await pool.query(`INSERT INTO public.commande_ligne
      (commande_id,designation,quantite,unite,prix_unitaire_ht,taux_tva,delai_client,delai_interne)
      VALUES (112,'Synthetic duplicate fixture',3,'u',40,20,'2026-10-25','2026-03-29')`);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  it("reproduces PostgreSQL22007 from the former String(Date) path", async () => {
    const original = (await pool.query("SELECT delai_client FROM public.commande_ligne WHERE commande_id=112")).rows[0];
    expect(original.delai_client).toBeInstanceOf(Date);
    await expect(pool.query("INSERT INTO public.duplicate_date_copy VALUES (113,$1::date,NULL)", [String(original.delai_client)]))
      .rejects.toMatchObject({ code: "22007" });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.duplicate_date_copy")).rows[0].count).toBe(0);
  });

  for (const [timezone, dateStyle] of [
    ["Europe/Paris", "ISO, DMY"], ["Pacific/Honolulu", "ISO, MDY"],
    ["Pacific/Kiritimati", "SQL, DMY"], ["UTC", "SQL, MDY"],
  ]) {
    it(`copies exact civil dates in ${timezone} / ${dateStyle}`, async () => {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT set_config('TimeZone',$1,true),set_config('DateStyle',$2,true)", [timezone, dateStyle]);
        const lines = await readCommandeDuplicateLinesTx(tx, 112);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ delai_client: "2026-10-25", delai_interne: "2026-03-29", quantite: "3", prix_unitaire_ht: "40" });
        await tx.query("INSERT INTO public.duplicate_date_copy VALUES (113,$1::date,$2::date)", [lines[0].delai_client, lines[0].delai_interne]);
        const copied = (await tx.query("SELECT to_char(client_due,'YYYY-MM-DD') AS client_due,to_char(internal_due,'YYYY-MM-DD') AS internal_due FROM public.duplicate_date_copy WHERE commande_id=113")).rows[0];
        expect(copied).toEqual({ client_due: "2026-10-25", internal_due: "2026-03-29" });
        expect((await readCommandeDuplicateLinesTx(tx, 112))[0]).toEqual(lines[0]);
      } finally { await tx.query("ROLLBACK"); tx.release(); }
    });
  }

  it("preserves null dates and stable line ordering without inventing a target", async () => {
    await pool.query(`INSERT INTO public.commande_ligne (commande_id,designation,quantite,prix_unitaire_ht)
      VALUES (112,'Undated synthetic line',1,0)`);
    const lines = await readCommandeDuplicateLinesTx(pool, 112);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ designation: "Undated synthetic line", delai_client: null, delai_interne: null });
    expect(await readCommandeDuplicateLinesTx(pool, 999)).toEqual([]);
  });
});
