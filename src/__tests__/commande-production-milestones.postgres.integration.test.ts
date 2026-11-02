import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type ProductionMilestones = typeof import("../module/commande-client/repository/commande-production-milestone.repository");
type CommandeRepository = typeof import("../module/commande-client/repository/commande-client.repository");

const databaseUrl = process.env.CERP_COMMANDE_MILESTONE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

let pool: Pool | null = null;
let tx: PoolClient | null = null;
let milestones: ProductionMilestones;
let commandes: CommandeRepository;

function requireIsolatedDatabase() {
  if (!databaseUrl) throw new Error("CERP_COMMANDE_MILESTONE_TEST_DATABASE_URL is required");
  if (process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match CERP_COMMANDE_MILESTONE_TEST_DATABASE_URL");
  }
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.port !== '56145' || url.pathname !== '/cerp_test') {
    throw new Error('Commande production milestone integration only runs on loopback:56145/cerp_test');
  }
}

async function seedOrder(client: PoolClient, status: 'AR_ENVOYE' | 'PLANNING_VALIDE') {
  const created = await client.query<{ id: string }>(`
    INSERT INTO public.commande_client(numero,date_commande,total_ht,total_ttc,order_type)
    VALUES($1,CURRENT_DATE,0,0,'FERME') RETURNING id::text AS id
  `, [`PROD-MILESTONE-${randomUUID().slice(0, 12)}`]);
  const orderId = Number(created.rows[0]!.id);
  await client.query(
    "INSERT INTO public.commande_historique(commande_id,nouveau_statut) VALUES($1,$2)",
    [orderId, status],
  );
  await commandes.repoEnsureCommandeWorkflowCheckpoints(client, orderId, status);
  return orderId;
}

async function setCheckpoint(client: PoolClient, orderId: number, code: string, status: 'active' | 'pending' | 'blocked') {
  await client.query(
    "UPDATE public.commande_client_workflow_checkpoint SET status=$3 WHERE commande_id=$1 AND checkpoint_code=$2",
    [orderId, code, status],
  );
}

async function seedTwoLinkedOfs(client: PoolClient, orderId: number) {
  const line = await client.query<{ id: string }>(`
    INSERT INTO public.commande_ligne(commande_id,designation,quantite,unite,prix_unitaire_ht)
    VALUES($1,'Ligne uniquement rattachée',2,'u',0) RETURNING id::text AS id
  `, [orderId]);
  const piece = await client.query<{ id: string }>("SELECT id::text AS id FROM public.pieces_techniques ORDER BY id LIMIT 1");
  if (!piece.rows[0]) throw new Error('Fixture requires a technical piece');
  const direct = await client.query<{ id: string }>(`
    INSERT INTO public.ordres_fabrication(numero,piece_technique_id,commande_id,statut,quantite_lancee)
    VALUES($1,$2::uuid,$3,'PLANIFIE',1) RETURNING id::text AS id
  `, [`OF-DIRECT-${orderId}`, piece.rows[0].id, orderId]);
  const byLine = await client.query<{ id: string }>(`
    INSERT INTO public.ordres_fabrication(numero,piece_technique_id,commande_ligne_id,statut,quantite_lancee)
    VALUES($1,$2::uuid,$3,'PLANIFIE',1) RETURNING id::text AS id
  `, [`OF-LIGNE-${orderId}`, piece.rows[0].id, line.rows[0]!.id]);
  const directId = Number(direct.rows[0]!.id);
  const lineId = Number(byLine.rows[0]!.id);
  // The database itself prohibits starting an OF without a durable release
  // decision. Seed that genuine prerequisite; the milestone reconciler is
  // intentionally tested only after the workshop release has happened.
  await client.query(
    `INSERT INTO public.of_release_decisions(of_id,decision,override,blocker_codes,evidence)
     VALUES($1,'RELEASED',false,ARRAY[]::text[],'{}'::jsonb),
           ($2,'RELEASED',false,ARRAY[]::text[],'{}'::jsonb)`,
    [directId, lineId],
  );
  return { directId, lineId };
}

async function history(client: PoolClient, orderId: number) {
  const rows = await client.query<{ nouveau_statut: string }>(`
    SELECT nouveau_statut FROM public.commande_historique
    WHERE commande_id=$1 ORDER BY id
  `, [orderId]);
  return rows.rows.map((row) => row.nouveau_statut);
}

async function checkpointStatus(client: PoolClient, orderId: number, code: string) {
  const row = await client.query<{ status: string }>(`
    SELECT status FROM public.commande_client_workflow_checkpoint
    WHERE commande_id=$1 AND checkpoint_code=$2
  `, [orderId, code]);
  return row.rows[0]?.status;
}

suite('commande production milestones — isolated PostgreSQL', () => {
  beforeAll(async () => {
    requireIsolatedDatabase();
    pool = new Pool({ connectionString: databaseUrl });
    milestones = await import('../module/commande-client/repository/commande-production-milestone.repository');
    commandes = await import('../module/commande-client/repository/commande-client.repository');
  });

  beforeEach(async () => {
    if (!pool) throw new Error('pool unavailable');
    tx = await pool.connect();
    await tx.query('BEGIN');
  });

  afterEach(async () => {
    await tx?.query('ROLLBACK').catch(() => undefined);
    tx?.release();
    tx = null;
  });

  it('waits for direct and line-only OFs, then reconciles each durable milestone once', async () => {
    if (!tx) throw new Error('transaction unavailable');
    const orderId = await seedOrder(tx, 'AR_ENVOYE');
    const ofs = await seedTwoLinkedOfs(tx, orderId);

    await tx.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id=$1", [ofs.directId]);
    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE']);
    expect(await checkpointStatus(tx, orderId, 'production_launch')).toBe('active');

    await tx.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id=$1", [ofs.lineId]);
    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE', 'EN_PRODUCTION']);
    expect(await checkpointStatus(tx, orderId, 'production_launch')).toBe('done');
    expect(await checkpointStatus(tx, orderId, 'production_completion')).toBe('active');

    await tx.query("UPDATE public.ordres_fabrication SET statut='TERMINE' WHERE id=$1", [ofs.directId]);
    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE', 'EN_PRODUCTION']);

    await tx.query("UPDATE public.ordres_fabrication SET statut='CLOTURE' WHERE id=$1", [ofs.lineId]);
    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE', 'EN_PRODUCTION', 'PRODUCTION_TERMINEE']);
    expect(await checkpointStatus(tx, orderId, 'production_completion')).toBe('done');
    expect(await checkpointStatus(tx, orderId, 'quality_control')).toBe('active');

    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId, orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE', 'EN_PRODUCTION', 'PRODUCTION_TERMINEE']);
  });

  it('does not infer production from OFs when the AR was not sent', async () => {
    if (!tx) throw new Error('transaction unavailable');
    const orderId = await seedOrder(tx, 'PLANNING_VALIDE');
    const ofs = await seedTwoLinkedOfs(tx, orderId);
    await setCheckpoint(tx, orderId, 'production_launch', 'active');
    await setCheckpoint(tx, orderId, 'production_completion', 'pending');
    await tx.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id IN ($1,$2)", [ofs.directId, ofs.lineId]);

    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['PLANNING_VALIDE']);
    expect(await checkpointStatus(tx, orderId, 'production_launch')).toBe('active');
  });

  it('preserves an explicitly blocked production checkpoint', async () => {
    if (!tx) throw new Error('transaction unavailable');
    const orderId = await seedOrder(tx, 'AR_ENVOYE');
    const ofs = await seedTwoLinkedOfs(tx, orderId);
    await setCheckpoint(tx, orderId, 'production_launch', 'blocked');
    await tx.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id IN ($1,$2)", [ofs.directId, ofs.lineId]);

    await milestones.reconcileCommandeProductionMilestonesInTransaction({ client: tx, actorUserId: null, orderIds: [orderId] });
    expect(await history(tx, orderId)).toEqual(['AR_ENVOYE']);
    expect(await checkpointStatus(tx, orderId, 'production_launch')).toBe('blocked');
  });
});

afterAll(async () => {
  await pool?.end();
});
