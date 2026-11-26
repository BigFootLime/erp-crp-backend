import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPilotFixtureClient } from "../../../__tests__/fixtures/demand-pilot.fixture";
import pool from "../../../config/database";
import { repoListAffairesCommandCenter } from "../../affaire/repository/affaire.repository";
import { listAffairesCommandCenterQuerySchema } from "../../affaire/validators/affaire.validators";
import { listClients } from "../../client/services/client.service";
import { listDevisClientReferences } from "../../devis/services/devis-references.service";
import { repoListPlanningReferenceClients } from "../../planning/repository/planning-references.repository";
import { repoListProductionReferenceClients } from "../../production/repository/production-references.repository";
import { listCommandeClientReferences } from "../services/commande-client-references.service";
import { listCommandesQuerySchema } from "../validators/commande-client.validators";
import { repoListCommandes } from "./commande-client.repository";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_COMMERCIAL_LIST_POSTGRES_TEST === "1" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";

describe.skipIf(!isolated)("commercial list projections on PostgreSQL", () => {
  const prefix = `LIST-${randomUUID().slice(0, 8)}`;
  const codeNumber = Number.parseInt(randomUUID().slice(0, 5), 16) + 1_000;
  const firstCode = `CLI ${codeNumber}`;
  const secondCode = `CLI-${codeNumber + 9}`;
  let firstClient: string;
  let secondClient: string;
  let uncodedClient: string;

  beforeAll(async () => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      firstClient = await createPilotFixtureClient(tx, "V", `${prefix} Zulu`);
      secondClient = await createPilotFixtureClient(tx, "V", `${prefix} Alpha`);
      uncodedClient = await createPilotFixtureClient(tx, "V", `${prefix} Beta`);
      await tx.query("UPDATE public.clients SET client_code = $1 WHERE client_id = $2", [firstCode, firstClient]);
      await tx.query("UPDATE public.clients SET client_code = $1 WHERE client_id = $2", [secondCode, secondClient]);
      await tx.query(`UPDATE public.clients SET client_code =
        (SELECT repeat(' ', 1 + COALESCE(MAX(length(client_code)), 0)) FROM public.clients WHERE btrim(client_code) = '')
        WHERE client_id = $1`, [uncodedClient]);

      const piece = randomUUID();
      const version = randomUUID();
      await tx.query(`INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,code_piece,name_piece,designation)
        VALUES ($1,$1,1,$2,$2,$2)`, [piece, prefix]);
      await tx.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,plan_reference,indice,indice_externe_original,statut)
        VALUES ($1,$2,'PL-FIGE','B','B.1','BROUILLON'), ($3,$2,'PL-COURANT','C','C','BROUILLON')`,
      [version, piece, randomUUID()]);

      const orders = await tx.query<{ id: string }>(`INSERT INTO public.commande_client
        (numero, client_id, order_type, updated_at)
        VALUES ($1,$4,'FERME','2030-01-02'), ($2,$4,'FERME','2030-01-02'), ($3,$4,'FERME','2030-01-02')
        RETURNING id::text`, [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`, firstClient]);
      const [split, legacy] = orders.rows.map(o => o.id);
      const lines = await tx.query<{ id: string }>(`INSERT INTO public.commande_ligne
        (commande_id,code_piece,designation,piece_technique_version_id)
        VALUES ($1,'REF-CERP','Support fixe',$3), ($1,'REF-02','Entretoise',NULL),
               ($1,'REF-03','Bride',NULL), ($1,'REF-04','Moyeu',NULL), ($2,'REF-LEG','Pièce historique',NULL)
        RETURNING id::text`, [split, legacy, version]);

      const affaires = await tx.query<{ id: string }>(`INSERT INTO public.affaire
        (reference, client_id, commande_id, type_affaire, statut, date_ouverture, updated_at)
        VALUES ($1,$7,$4,'livraison','OUVERTE','2030-01-02','2030-01-02'),
               ($2,$7,$4,'livraison','OUVERTE','2030-01-02','2030-01-02'),
               ($3,$7,$5,'livraison','OUVERTE','2030-01-02','2030-01-02'),
               ($6,$7,$4,'projet','OUVERTE','2030-01-02','2030-01-02')
        RETURNING id::text`, [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`, split, legacy, `${prefix}-D`, firstClient]);
      await tx.query(`INSERT INTO public.commande_ligne_affaire_allocation
        (commande_id, commande_ligne_id, livraison_affaire_id, production_affaire_id, qty_ordered)
        VALUES ($1,$2,$3,NULL,1), ($1,$4,$5,$6,1)`,
      [split, lines.rows[0].id, affaires.rows[0].id, lines.rows[1].id, affaires.rows[1].id, affaires.rows[3].id]);

      const quote = (await tx.query<{ id: string }>(`
        WITH next AS (SELECT nextval(pg_get_serial_sequence('public.devis','id')) AS id)
        INSERT INTO public.devis (id, numero, client_id, root_devis_id, version_number)
        SELECT id,$1,$2,id,1 FROM next RETURNING id::text`, [`QUOTE-${prefix}`, firstClient])).rows[0].id;
      await tx.query(`INSERT INTO public.devis_ligne (devis_id, description, position)
        VALUES ($1,'Devis ligne deux',2), ($1,'Devis ligne une',1)`, [quote]);
      await tx.query(`INSERT INTO public.affaire
        (reference, client_id, devis_id, type_affaire, statut, date_ouverture)
        VALUES ($1,$3,$2,'livraison','OUVERTE','2030-01-02')`, [`${prefix}-E`, quote, firstClient]);

      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  });

  afterAll(() => pool.end());

  it("sorts numerically by code before the limit across selector endpoints", async () => {
    const expected = [firstClient, secondClient];
    const common = await listClients(prefix, 2);
    const orders = await listCommandeClientReferences({ q: prefix, limit: 2 });
    const quotes = await listDevisClientReferences({ q: prefix, limit: 2 });
    const planning = await repoListPlanningReferenceClients({ q: prefix, limit: 2 });
    const production = await repoListProductionReferenceClients({ q: prefix, limit: 2 });
    for (const rows of [common, orders, quotes, planning.items]) {
      expect(rows.map(row => row.client_id)).toEqual(expected);
    }
    expect(production.items.map(row => row.value)).toEqual(expected);
    expect(planning.hasMore).toBe(true);
    expect((await listClients(prefix, 3)).map(row => row.client_id)).toEqual([...expected, uncodedClient]);
    expect((await repoListPlanningReferenceClients({ q: firstCode, limit: 100 })).items).toContainEqual({
      client_id: firstClient, client_code: firstCode, company_name: `${prefix} Zulu`,
    });
  });

  it("keeps the exact order revision and stable pages with several and zero lines", async () => {
    const args = { q: prefix, pageSize: 1, sortBy: "updated_at", sortDir: "asc" };
    const pages = await Promise.all([1, 2, 3].map(page =>
      repoListCommandes(listCommandesQuerySchema.parse({ ...args, page })),
    ));
    expect(pages.map(page => page.total)).toEqual([3, 3, 3]);
    const items = pages.map(page => page.items[0]);
    expect(items.map(item => item.numero)).toEqual([`${prefix}-A`, `${prefix}-B`, `${prefix}-C`]);
    expect(items[0].line_summary).toEqual({
      total: 4,
      items: [
        { reference: "PL-FIGE", indice: "B.1", designation: "Support fixe" },
        { reference: "REF-02", indice: null, designation: "Entretoise" },
        { reference: "REF-03", indice: null, designation: "Bride" },
      ],
    });
    expect(items[2].line_summary).toEqual({ total: 0, items: [] });
  });

  it("scopes allocations to their delivery or production affaire and keeps order and quote fallbacks", async () => {
    const page = await repoListAffairesCommandCenter(listAffairesCommandCenterQuerySchema.parse({
      q: prefix, sortBy: "reference", sortDir: "asc",
    }));
    expect(page.total).toBe(5);
    expect(page.items.map(item => item.line_summary)).toEqual([
      { total: 1, items: [{ reference: "PL-FIGE", indice: "B.1", designation: "Support fixe" }] },
      { total: 1, items: [{ reference: "REF-02", indice: null, designation: "Entretoise" }] },
      { total: 1, items: [{ reference: "REF-LEG", indice: null, designation: "Pièce historique" }] },
      { total: 1, items: [{ reference: "REF-02", indice: null, designation: "Entretoise" }] },
      { total: 2, items: [
        { reference: null, indice: null, designation: "Devis ligne une" },
        { reference: null, indice: null, designation: "Devis ligne deux" },
      ] },
    ]);
  });
});
