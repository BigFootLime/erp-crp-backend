import { Pool } from "pg";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Isolated, opt-in coverage for the AR readiness barrier.  This deliberately
 * uses the local disposable cerp_test cluster, never the application default.
 */
type ArRepository = typeof import("../module/commande-client/repository/commande-ar.repository");
type ReadinessRepository = typeof import("../module/commande-client/repository/commande-ar-readiness.repository");

const integrationUrl = process.env.CERP_AR_GUARD_TEST_DATABASE_URL;
const describePg = integrationUrl ? describe : describe.skip;

let harness: Pool | null = null;
let appPool: Pool | null = null;
let tx: PoolClient | null = null;
let arRepository: ArRepository;
let readiness: ReadinessRepository;

function requireIsolatedDatabase() {
  if (!integrationUrl) throw new Error("CERP_AR_GUARD_TEST_DATABASE_URL is required");
  if (process.env.DATABASE_URL !== integrationUrl) {
    throw new Error("DATABASE_URL must exactly match CERP_AR_GUARD_TEST_DATABASE_URL");
  }
  const url = new URL(integrationUrl);
  const allowedPort = process.env.CERP_AR_GUARD_TEST_PORT ?? "56144";
  if (!(url.hostname === "127.0.0.1" || url.hostname === "localhost") || url.port !== allowedPort || url.pathname !== "/cerp_test") {
    throw new Error(`AR readiness integration tests only run on loopback:${allowedPort}/cerp_test`);
  }
}

async function seedCommande(db: PoolClient, token: string, status: "PLANNING_VALIDE" | "AR_PRET", checkpoint: "ar_preparation" | "ar_sent") {
  const command = await db.query<{ id: string }>(`INSERT INTO public.commande_client(numero,date_commande,total_ht,total_ttc,order_type)
    VALUES($1,CURRENT_DATE,0,0,'FERME') RETURNING id::text AS id`, [`AR-GUARD-${token}`]);
  const orderId = Number(command.rows[0]!.id);
  await db.query("INSERT INTO public.commande_historique(commande_id, nouveau_statut) VALUES ($1, $2)", [orderId, status]);
  await db.query(`INSERT INTO public.commande_client_workflow_checkpoint(commande_id,checkpoint_code,label,sort_order,status,responsible_role)
    VALUES($1,$2,'Fixture AR',1,'active','secretariat')`, [orderId, checkpoint]);
  return orderId;
}

async function seedFullyPlannedManufacturing(db: PoolClient, orderId: number) {
  const piece = await db.query<{ id: string }>("SELECT id::text AS id FROM public.pieces_techniques ORDER BY id LIMIT 1");
  if (!piece.rows[0]) throw new Error("Fixture requires an existing technical piece");
  const line = await db.query<{ id: string }>(`INSERT INTO public.commande_ligne(commande_id,designation,quantite,unite,prix_unitaire_ht)
    VALUES($1,'Ligne AR synthétique',5,'u',0) RETURNING id::text AS id`, [orderId]);
  const of = await db.query<{ id: string }>(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,commande_id,commande_ligne_id,statut,technical_readiness,technical_snapshot_sha256,technical_snapshot,quantite_lancee)
    VALUES($1,$2::uuid,$3,$4,'PLANIFIE','VALIDATED',repeat('a',64),'{"operations":[{"phase":10}]}'::jsonb,5) RETURNING id::text AS id`, [`OF-AR-${orderId}`, piece.rows[0].id, orderId, line.rows[0].id]);
  const revision = randomUUID();
  await db.query("INSERT INTO public.of_revisions(id,of_id,statut,revision_rank,revision_code,motif,snapshot,snapshot_sha256) VALUES($1::uuid,$2,'ACTIVE',1,'R01','Fixture','{}'::jsonb,repeat('b',64))", [revision, of.rows[0].id]);
  const operation = await db.query<{ id: string }>(`INSERT INTO public.of_operations(of_id,phase,designation,revision_id,status)
    VALUES($1,10,'Opération AR',$2::uuid,'READY') RETURNING id::text AS id`, [of.rows[0].id, revision]);
  const eventId = randomUUID();
  await db.query(`INSERT INTO public.planning_events(id,title,of_operation_id,status,start_ts,end_ts,machine_id)
    SELECT $1::uuid,'Créneau AR',$2,'PLANNED',free.start_at,free.start_at+interval '1 hour',machine.id
    FROM (SELECT id FROM public.machines ORDER BY id LIMIT 1 FOR UPDATE) machine
    CROSS JOIN LATERAL (SELECT GREATEST(now(),max(e.end_ts))+interval '1 minute' AS start_at
      FROM public.planning_events e WHERE e.machine_id=machine.id AND e.archived_at IS NULL AND e.status<>'CANCELLED') free`, [eventId, operation.rows[0].id]);
  return { eventId };
}

describePg("AR readiness barrier — isolated PostgreSQL", () => {
  beforeAll(async () => {
    requireIsolatedDatabase();
    harness = new Pool({ connectionString: integrationUrl });
    const databaseModule = await import("../config/database");
    appPool = databaseModule.default;
    arRepository = await import("../module/commande-client/repository/commande-ar.repository");
    readiness = await import("../module/commande-client/repository/commande-ar-readiness.repository");
  });

  beforeEach(async () => {
    if (!harness) throw new Error("harness unavailable");
    tx = await harness.connect();
    await tx.query("BEGIN");
  });

  afterEach(async () => {
    await tx?.query("ROLLBACK").catch(() => undefined);
    tx?.release();
    tx = null;
  });

  it("refuses a historical AR_PRET that predates every OF, planning proof and AR preparation", async () => {
    if (!tx) throw new Error("transaction unavailable");
    const orderId = await seedCommande(tx, "101", "AR_PRET", "ar_sent");

    await expect(arRepository.repoAuthorizeCommandeArGeneration({
      tx, commande_id: orderId, user_id: 7, user_role: "Secretaire", stage: "preview",
    })).rejects.toMatchObject({ status: 409, code: "COMMAND_AR_COVERAGE_REQUIRED" });
  });

  it("does not claim an AR for sending when its document row is absent", async () => {
    if (!tx) throw new Error("transaction unavailable");
    const orderId = await seedCommande(tx, "102", "AR_PRET", "ar_sent");
    const arId = "00000000-0000-4000-8000-000000000102";
    await tx.query("SAVEPOINT ar_without_document");
    await expect(tx.query("INSERT INTO public.commande_ar_log(id, commande_id, document_id, ar_series_number, version_number, ar_reference) VALUES ($1::uuid,$2,$3::uuid,1,1,'AR-FIXTURE')", [arId, orderId, "00000000-0000-4000-8000-000000000202"])).rejects.toMatchObject({ code: "23503" });
    await tx.query("ROLLBACK TO SAVEPOINT ar_without_document");
    const row = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM public.commande_ar_log WHERE commande_id=$1", [orderId]);
    expect(row.rows[0]?.count).toBe(0);
  });

  it("authorizes an AR only after every active operation has a valid, qualified slot", async () => {
    if (!tx) throw new Error("transaction unavailable");
    const orderId = await seedCommande(tx, "103", "PLANNING_VALIDE", "ar_preparation");
    const seeded = await seedFullyPlannedManufacturing(tx, orderId);

    await expect(arRepository.repoAuthorizeCommandeArGeneration({
      tx, commande_id: orderId, user_id: 7, user_role: "Secretaire", stage: "preview",
    })).resolves.toBeUndefined();

    await tx.query("UPDATE public.planning_events SET status='CANCELLED' WHERE id=$1::uuid", [seeded.eventId]);
    await expect(arRepository.repoAuthorizeCommandeArGeneration({
      tx, commande_id: orderId, user_id: 7, user_role: "Secretaire", stage: "preview",
    })).rejects.toMatchObject({ status: 409, code: "PLANNING_REQUIRES_PLANNED_OF" });
  });

  it("accepts a fully reserved 100% stock order but rejects partial and expired reservations", async () => {
    if (!tx) throw new Error("transaction unavailable");
    const orderId = await seedCommande(tx, "104", "PLANNING_VALIDE", "ar_preparation");
    const article = await tx.query<{ id: string }>("SELECT f.article_id::text AS id FROM public.articles_fabrique f JOIN public.articles a ON a.id=f.article_id WHERE NOT a.lot_tracking ORDER BY f.article_id LIMIT 1");
    const location = await tx.query<{ id: string }>("SELECT id::text AS id FROM public.locations ORDER BY id LIMIT 1");
    const actor = await tx.query<{ id: number }>("SELECT id::int AS id FROM public.users ORDER BY id LIMIT 1");
    if (!article.rows[0] || !location.rows[0] || !actor.rows[0]) throw new Error("Fixture requires an article, stock location and actor");
    const line = await tx.query<{ id: string }>("INSERT INTO public.commande_ligne(commande_id,designation,quantite,unite,prix_unitaire_ht,article_id) VALUES($1,'Stock AR',5,'u',0,$2::uuid) RETURNING id::text AS id", [orderId, article.rows[0].id]);
    const reservation = await tx.query<{ id: string }>(`INSERT INTO public.stock_reservations(article_id,location_id,commande_ligne_id,qty_reserved,source_type,source_id,status,created_by)
      VALUES($1::uuid,$2::uuid,$3::bigint,5,'COMMANDE_LIGNE',$4::text,'ACTIVE',$5) RETURNING id::text AS id`, [article.rows[0].id, location.rows[0].id, line.rows[0].id, line.rows[0].id, actor.rows[0].id]);
    await expect(readiness.assertOrderArReady(tx, orderId)).resolves.toBeUndefined();

    await tx.query("UPDATE public.stock_reservations SET qty_reserved=4 WHERE id=$1::uuid", [reservation.rows[0].id]);
    await expect(readiness.assertOrderArReady(tx, orderId)).rejects.toMatchObject({ status: 409, code: "COMMAND_AR_COVERAGE_REQUIRED" });
    await tx.query("UPDATE public.stock_reservations SET qty_reserved=5, expires_at=now()-interval '1 second' WHERE id=$1::uuid", [reservation.rows[0].id]);
    await expect(readiness.assertOrderArReady(tx, orderId)).rejects.toMatchObject({ status: 409, code: "COMMAND_AR_COVERAGE_REQUIRED" });
  });
});

afterAll(async () => {
  await appPool?.end();
  await harness?.end();
});
