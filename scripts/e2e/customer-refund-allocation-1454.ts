/* Transactional regression for CUSTOMER-REFUND-1268.  It never commits. */
import pool from "../../src/config/database";

const invoiceId = Number(process.argv[2] ?? "8");
if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error("usage: customer-refund-allocation-1454.ts INVOICE_ID");

async function expectRejected(client: import("pg").PoolClient, label: string, action: () => Promise<unknown>) {
  await client.query(`SAVEPOINT ${label}`);
  try { await action(); throw new Error(`${label}_WAS_ACCEPTED`); }
  catch (error) {
    if (error instanceof Error && error.message === `${label}_WAS_ACCEPTED`) throw error;
    const code = (error as { code?: string }).code;
    if (code !== "23514" && code !== "55000") throw error;
  } finally { await client.query(`ROLLBACK TO SAVEPOINT ${label}`); }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoice = await client.query<{ id: number; client_id: string; total_ttc: string; currency: string; document_status: string }>(
      "SELECT id,client_id,total_ttc::text,currency,document_status FROM facture WHERE id=$1 FOR UPDATE", [invoiceId]);
    const row = invoice.rows[0];
    if (!row || row.document_status !== "ISSUED") throw new Error("TEST issued invoice required");
    const credit = await client.query<{ id: number }>(`
      INSERT INTO avoir(numero,legal_number,client_id,facture_id,statut,total_ht,total_ttc,total_tax,currency,uuid,created_by,issued_at,issued_by,immutable_snapshot,document_checksum_sha256)
      VALUES($1,$2,$3,$4,'ISSUED',83.33,100,16.67,$5,gen_random_uuid(),1,now(),1,jsonb_build_object('test',true),repeat('a',64)) RETURNING id`, [`REFUND-TEST-${process.pid}`, `REFUND-TEST-${process.pid}`, row.client_id, row.id, row.currency]);
    const creditId = credit.rows[0]?.id;
    if (!creditId) throw new Error("TEST credit creation failed");
    await client.query(`INSERT INTO customer_refunds(id,code,facture_id,avoir_id,client_id,currency,amount_ttc,value_date,booking_date,mode,reference,reason,source_snapshot,created_by,correlation_id)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,100,current_date,current_date,'TEST','refund-test','TEST refund regression',jsonb_build_object('version',1),1,gen_random_uuid())`, [`REFUND-TEST-${process.pid}`, row.id, creditId, row.client_id, row.currency]);
    const payment = await client.query<{ id: number }>(`
      INSERT INTO paiement(client_id,montant,mode,reference,uuid,code,status,currency,value_date,booking_date,created_by,workflow_status,received_at,received_by,correlation_id,idempotency_key,request_hash)
      VALUES($1,$2,'TEST','refund-net',gen_random_uuid(),$3,'ALLOCATED',$4,current_date,current_date,1,'ALLOCATED',now(),1,gen_random_uuid(),$5,repeat('b',64)) RETURNING id`, [row.client_id, row.total_ttc, `PAY-${process.pid}`, row.currency, `refund-net-${process.pid}`]);
    await client.query("INSERT INTO paiement_allocations(paiement_id,facture_id,amount_ttc,created_by) VALUES($1,$2,$3,1)", [payment.rows[0]?.id, row.id, row.total_ttc]);
    await expectRejected(client, "OVER_ALLOCATION", async () => {
      const extra = await client.query<{ id: number }>(`INSERT INTO paiement(client_id,montant,mode,reference,uuid,code,status,currency,value_date,booking_date,created_by,workflow_status,received_at,received_by,correlation_id,idempotency_key,request_hash)
        VALUES($1,1,'TEST','over',gen_random_uuid(),$2,'ALLOCATED',$3,current_date,current_date,1,'ALLOCATED',now(),1,gen_random_uuid(),$4,repeat('c',64)) RETURNING id`, [row.client_id, `PAY-OVER-${process.pid}`, row.currency, `over-${process.pid}`]);
      await client.query("INSERT INTO paiement_allocations(paiement_id,facture_id,amount_ttc,created_by) VALUES($1,$2,1,1)", [extra.rows[0]?.id, row.id]);
    });
    await expectRejected(client, "LEGACY_DIRECT_CONVERSION", async () => {
      const legacy = await client.query<{ id: number }>("INSERT INTO paiement(facture_id,client_id,montant,mode,reference,currency) VALUES($1,$2,1,'TEST','legacy',$3) RETURNING id", [row.id, row.client_id, row.currency]);
      await client.query("INSERT INTO paiement_allocations(paiement_id,facture_id,amount_ttc,created_by) VALUES($1,$2,1,1)", [legacy.rows[0]?.id, row.id]);
    });
    await expectRejected(client, "CREDIT_CLIENT_MISMATCH", async () => {
      const wrong = await client.query<{ id: number }>("INSERT INTO avoir(numero,client_id,facture_id,statut,total_ht,total_ttc,total_tax,currency,uuid,created_by,document_checksum_sha256) VALUES($1,'BAD',$2,'BROUILLON',1,1,0,$3,gen_random_uuid(),1,repeat('d',64)) RETURNING id", [`REFUND-MISMATCH-${process.pid}`, row.id, row.currency]);
      await client.query("INSERT INTO avoir_source_allocations(avoir_id,facture_id,amount_ttc,allocation_status,created_by) VALUES($1,$2,1,'CONSUMED',1)", [wrong.rows[0]?.id, row.id]);
    });
    await client.query("ROLLBACK");
    process.stdout.write(`CUSTOMER_REFUND_ALLOCATION_PASS ${JSON.stringify({ invoice_id: row.id, refund_amount: "100.00", net_payment_allowed: row.total_ttc, over_allocation_rejected: true, legacy_direct_rejected: true, credit_client_mismatch_rejected: true, rollback: true })}\n`);
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { process.stderr.write(`CUSTOMER_REFUND_ALLOCATION_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
