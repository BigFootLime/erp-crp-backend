import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoCreateCommandeCutoverDraftTx } from "../../../commande-client/repository/commande-client.repository";
import { repoCreateCommandeFournisseurTx } from "../../../commande-fournisseur/repository/commande-fournisseur.repository";
import { createCommandeSchema } from "../../../commande-fournisseur/validators/commande-fournisseur.validators";

const url = process.env.CERP_CUTOVER_NATIVE_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
let db: Pool;
let customerId = "";
const article = "11111111-1111-4111-8111-111111111111";
const supplier = "22222222-2222-4222-8222-222222222222";
const technical = "33333333-3333-4333-8333-333333333333";
const audit = { user_id: 1, role: "SuperAdmin", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };

async function tx<T>(work: (client: PoolClient) => Promise<T>) { const client = await db.connect(); try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }

describePg("native cutover order writers PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Native cutover URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55471' || parsed.pathname !== '/cerp_cutover_native_1710') throw new Error("Refusing non-disposable native clone");
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_native_1710") throw new Error("Unexpected native clone identity");
  });
  beforeEach(async () => {
    await db.query("INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
    await db.query("INSERT INTO public.users(id,username,password,name,surname,email,role) VALUES(1,'cutover-native','$2b$10$2b2xOYbkQN.mZSOEbttK8uF.4RF6W2Ah4D.yMY0J9ZwT4xteq1RQC','Cutover','Native','cutover-native@example.invalid','Administrateur Systeme et Reseau') ON CONFLICT(id) DO NOTHING");
    await db.query("INSERT INTO public.clients(client_id,client_code,company_name) VALUES('771','CUT-771','Client cutover') ON CONFLICT(client_code) DO NOTHING");
    customerId = (await db.query<{ client_id: string }>("SELECT client_id FROM public.clients WHERE client_code='CUT-771'")).rows[0]!.client_id;
    await db.query("INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,name_piece,code_piece,designation,created_by,updated_by) VALUES($1::uuid,$1::uuid,1,'Piece cutover','PT-CUT','Piece cutover',1,1) ON CONFLICT(id) DO NOTHING", [technical]);
    await db.query("INSERT INTO public.articles(id,root_article_id,code,designation,family_code,version_number,plan_index,status,article_type,article_category,unite,stock_managed,lot_tracking,piece_technique_id,is_active,created_by,updated_by) VALUES($1::uuid,$1::uuid,'CUT-ART','Article cutover','CUT',1,1,'VALIDE','PIECE_TECHNIQUE','fabrique','U',true,false,$2::uuid,true,1,1) ON CONFLICT(id) DO UPDATE SET article_type='PIECE_TECHNIQUE',article_category='fabrique',piece_technique_id=EXCLUDED.piece_technique_id,is_active=true,stock_managed=true", [article, technical]);
    await db.query("INSERT INTO public.articles_fabrique_families(code,designation) VALUES('CUT','Famille cutover') ON CONFLICT(code) DO NOTHING");
    await db.query("INSERT INTO public.articles_fabrique(article_id,family_code,piece_technique_id) VALUES($1::uuid,'CUT',$2::uuid) ON CONFLICT(article_id) DO UPDATE SET piece_technique_id=EXCLUDED.piece_technique_id", [article, technical]);
    await db.query("INSERT INTO public.currencies(code,name) VALUES('EUR','Euro') ON CONFLICT(code) DO NOTHING");
    await db.query("INSERT INTO public.fournisseurs(id,code,code_fournisseur,nom,raison_sociale,created_by,updated_by) VALUES($1::uuid,'CUT-FOU','CUT-FOU','Fournisseur cutover','Fournisseur cutover',1,1) ON CONFLICT(id) DO NOTHING", [supplier]);
  });
  afterAll(async () => { await db?.end(); });

  it("creates customer and internal draft orders for remaining 30, without delivery/stock/OF/AR artifacts", async () => {
    const customer = await tx((client) => repoCreateCommandeCutoverDraftTx(client, { client_id: customerId, code_client: 'PO-100', date_commande: '2026-10-20', order_type: 'FERME', save_intent: 'DRAFT', lignes: [
      { article_id: article, designation: 'Article cutover', quantite: 20, prix_unitaire_ht: 10, taux_tva: 20, unite: 'U', delai_client: '2026-11-01' },
      { article_id: article, designation: 'Article cutover', quantite: 10, prix_unitaire_ht: 10, taux_tva: 20, unite: 'U', delai_client: '2026-11-02' },
    ] }, 1));
    const internal = await tx((client) => repoCreateCommandeCutoverDraftTx(client, { date_commande: '2026-10-20', order_type: 'INTERNE', save_intent: 'DRAFT', total_ht: 0, total_ttc: 0, lignes: [{ article_id: article, designation: 'Article cutover', quantite: 30, prix_unitaire_ht: 0, taux_tva: 0, unite: 'U', delai_client: '2026-11-03' }] }, 1));
    const lines = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM public.commande_ligne WHERE commande_id=$1::bigint", [customer.id]);
    expect(lines.rows[0]?.n).toBe('2');
    expect(internal.id).toBeGreaterThan(0);
    const commandIds = [customer.id, internal.id];
    const sideEffects: Array<{ sql: string; values: unknown[] }> = [
      { sql: "SELECT count(*)::int AS n FROM public.affaire WHERE commande_id = ANY($1::bigint[])", values: [commandIds] },
      { sql: "SELECT count(*)::int AS n FROM public.bon_livraison WHERE commande_id = ANY($1::bigint[])", values: [commandIds] },
      { sql: "SELECT count(*)::int AS n FROM public.ordres_fabrication WHERE commande_id = ANY($1::bigint[])", values: [commandIds] },
      { sql: "SELECT count(*)::int AS n FROM public.commande_ar_log WHERE commande_id = ANY($1::bigint[])", values: [commandIds] },
      { sql: "SELECT count(*)::int AS n FROM public.stock_movements WHERE source_document_type = 'COMMANDE_CLIENT' AND source_document_id = ANY($1::text[])", values: [commandIds.map(String)] },
      { sql: "SELECT count(*)::int AS n FROM public.app_notifications WHERE entity_type = 'commande_client' AND entity_id = ANY($1::text[])", values: [commandIds.map(String)] },
    ];
    for (const effect of sideEffects) {
      const count = await db.query<{ n: number }>(effect.sql, effect.values);
      expect(count.rows[0]?.n).toBe(0);
    }
  });

  it("rolls back native customer draft when the outer cutover transaction fails", async () => {
    const client = await db.connect();
    try { await client.query('BEGIN'); await repoCreateCommandeCutoverDraftTx(client, { client_id: customerId, code_client: 'PO-ROLLBACK', date_commande: '2026-10-20', order_type: 'FERME', save_intent: 'DRAFT', lignes: [{ article_id: article, designation: 'Article', quantite: 1, prix_unitaire_ht: 10, taux_tva: 20, unite: 'U', delai_client: '2026-11-01' }] }, 1); await client.query('ROLLBACK'); } finally { client.release(); }
    expect((await db.query("SELECT count(*)::int AS n FROM public.commande_client WHERE code_client='PO-ROLLBACK' ")).rows[0]?.n).toBe(0);
  });

  it("creates supplier draft without its creation PDF queue", async () => {
    const result = await tx((client) => repoCreateCommandeFournisseurTx(createCommandeSchema.parse({ body: { fournisseur_id: supplier, origine: 'AUTRE', devise: 'EUR', lignes: [{ type: 'ARTICLE', article_id: article, designation: 'Article', unite: 'U', quantite: 30, prix_unitaire_ht: 5, tva_pct: 20, date_besoin: '2026-11-04' }] } }).body, audit, client, { sideEffects: 'none' }));
    expect(result.code).toMatch(/^BCF-/);
    const archives = await db.query("SELECT count(*)::int AS n FROM public.authoritative_pdf_archives WHERE entity_type='commande-fournisseur' AND entity_id=$1::text", [result.id]);
    expect(archives.rows[0]?.n).toBe(0);
  });
});

