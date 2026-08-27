import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pool from "../../config/database";
import {
  repoCancelAccountingBatch,
  repoCreateAccountingMapping,
  repoCreateAccountingPreview,
  repoDownloadAccountingArtifact,
  repoGenerateAccountingBatch,
  repoReexportAccountingBatch,
  repoValidateAccountingBatch,
} from "./accounting-export.repository";

const integration = process.env.CERP_SOL27_INTEGRATION === "1" ? describe : describe.skip;
const actor = { userId: 0, requestId: "sol27-integration-request", path: "/integration/accounting-exports" };

async function createInvoice(prefix: string): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO public.facture
      (numero,client_id,date_emission,date_echeance,statut,document_status,settlement_status,
       total_ht,total_tax,total_ttc,currency,uuid,created_by,correlation_id)
     VALUES ($1,'901','2026-08-14','2026-09-14','DRAFT','DRAFT','UNPAID',100,20,120,'EUR',$2::uuid,$3,$4::uuid)
     RETURNING id::int`,
    [`${prefix}-FAC`, crypto.randomUUID(), actor.userId, crypto.randomUUID()]
  );
  const id = inserted.rows[0]!.id;
  await pool.query(
    `INSERT INTO public.facture_ligne
      (facture_id,ordre,designation,quantite,unite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
     VALUES ($1,1,'Pièce SOL-27',1,'pce',100,0,20,100,20,120)`,
    [id]
  );
  await pool.query(
    `UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number=$2,legal_period='2026',
       legal_sequence_value=$3,immutable_snapshot='{}'::jsonb,document_checksum_sha256=$4,
       issued_at=now(),issued_by=$5,issue_snapshot='{}'::jsonb,issue_snapshot_sha256=$4
     WHERE id=$1`,
    [id, `${prefix}-FAC`, id, "a".repeat(64), actor.userId]
  );
  return id;
}

async function createCredit(prefix: string, factureId: number): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO public.avoir
      (numero,client_id,facture_id,date_emission,statut,total_ht,total_tax,total_ttc,currency,uuid,created_by,correlation_id)
     VALUES ($1,'901',$2,'2026-08-15','DRAFT',10,2,12,'EUR',$3::uuid,$4,$5::uuid)
     RETURNING id::int`,
    [`${prefix}-AV`, factureId, crypto.randomUUID(), actor.userId, crypto.randomUUID()]
  );
  const id = inserted.rows[0]!.id;
  await pool.query(
    `INSERT INTO public.avoir_ligne
      (avoir_id,ordre,designation,quantite,unite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
     VALUES ($1,1,'Correction SOL-27',1,'pce',10,0,20,10,2,12)`,
    [id]
  );
  await pool.query(
    `UPDATE public.avoir SET statut='ISSUED',legal_number=$2,legal_period='2026',legal_sequence_value=$3,
       immutable_snapshot='{}'::jsonb,document_checksum_sha256=$4,issued_at=now(),issued_by=$5,
       issue_snapshot='{}'::jsonb,issue_snapshot_sha256=$4 WHERE id=$1`,
    [id, `${prefix}-AV`, id, "b".repeat(64), actor.userId]
  );
  return id;
}

async function createPayment(prefix: string): Promise<number> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO public.paiement
      (facture_id,client_id,date_paiement,value_date,booking_date,montant,currency,mode,reference,
       uuid,code,status,workflow_status,row_version,created_by,received_by,received_at,correlation_id,idempotency_key,request_hash)
     VALUES (NULL,'901','2026-08-16','2026-08-16','2026-08-16',108,'EUR','VIREMENT',$1,$2::uuid,$3,
       'UNALLOCATED','RECORDED',1,$4,$4,now(),$5::uuid,$6,$7) RETURNING id::int`,
    [prefix, crypto.randomUUID(), `${prefix}-PAY`, actor.userId, crypto.randomUUID(), `${prefix}-payment`, "c".repeat(64)]
  );
  return inserted.rows[0]!.id;
}

integration("SOL-27 accounting export repository", () => {
  let paymentId = 0;
  let prefix = "";

  beforeAll(async () => {
    prefix = `SOL27-${Date.now()}`;
    const user = await pool.query<{ id: number }>("SELECT id::int FROM public.users WHERE username='E2E_ACCOUNTANT'");
    actor.userId = user.rows[0]?.id ?? 0;
    if (actor.userId <= 0) throw new Error("E2E_ACCOUNTANT fixture is missing");
    await pool.query("UPDATE public.clients SET compte_tiers='4110901' WHERE client_id='901'");
    const invoiceId = await createInvoice(prefix);
    await createCredit(prefix, invoiceId);
    paymentId = await createPayment(prefix);
  });

  afterAll(async () => { await pool.end(); });

  it("previews, validates, generates, replays, reconciles, cancels and reexports without duplicates", async () => {
    const mapping = await repoCreateAccountingMapping({
      actor,
      idempotencyKey: `${prefix}-mapping`,
      input: {
        version_code: `${prefix}-V1`, adapter_code: "GENERIC_DELIMITED_V1", effective_from: "2026-01-01",
        effective_to: null, activate: true,
        config: {
          delimiter: ";", sales_journal: "VE", credit_journal: "AV",
          bank_journal_by_mode: { VIREMENT: "BQ" }, bank_account_by_mode: { VIREMENT: "512100" },
          default_bank_journal: null, default_bank_account: null,
          sales_account_by_tax: { "20": "707000" }, vat_output_account_by_tax: { "20": "445710" },
          purchase_journal: null, supplier_credit_journal: null,
          purchase_account_by_tax_category: {}, vat_input_account_by_tax_category: {},
          reverse_charge_output_account_by_tax_category: {}, self_assessed_vat_rate_by_tax_category: {},
          fx_gain_account: null, fx_loss_account: null, default_axes: { SITE: "CRP" },
        },
      },
    });
    const preview = await repoCreateAccountingPreview({
      actor, idempotencyKey: `${prefix}-preview`,
      input: { mapping_version_id: mapping.id, period_from: "2026-08-14", period_to: "2026-08-16", source_types: ["INVOICE", "CREDIT_NOTE", "PAYMENT"] },
    });
    expect(preview.status).toBe("PREVIEWED");
    expect(preview.findings).toEqual([]);
    expect(preview.source_count).toBe(3);
    expect(preview.currency_totals).toEqual([{ currency: "EUR", debit: "240.00", credit: "240.00", balanced: true }]);

    const validated = await repoValidateAccountingBatch({ batchId: preview.id, body: { expected_version: preview.row_version }, actor, idempotencyKey: `${prefix}-validate` });
    expect(validated.status).toBe("VALIDATED");
    const generated = await repoGenerateAccountingBatch({ batchId: preview.id, body: { expected_version: validated.row_version }, actor, idempotencyKey: `${prefix}-generate` });
    expect(generated.status).toBe("GENERATED");
    expect(generated.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    const replay = await repoGenerateAccountingBatch({ batchId: preview.id, body: { expected_version: validated.row_version }, actor, idempotencyKey: `${prefix}-generate` });
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.id).toBe(generated.id);
    const artifact = await repoDownloadAccountingArtifact(generated.id);
    expect(artifact.content.toString("utf8")).toContain("JournalCode;EcritureDate;PieceRef");

    const duplicate = await repoCreateAccountingPreview({
      actor, idempotencyKey: `${prefix}-duplicate-preview`,
      input: { mapping_version_id: mapping.id, period_from: "2026-08-14", period_to: "2026-08-16", source_types: ["INVOICE", "CREDIT_NOTE", "PAYMENT"] },
    });
    expect(duplicate.findings.some((finding) => finding.code === "ACCOUNTING_SOURCE_ALREADY_EXPORTED")).toBe(true);

    const cancelled = await repoCancelAccountingBatch({ batchId: generated.id, body: { expected_version: generated.row_version, reason: "Import cabinet annulé pour reprise contrôlée" }, actor, idempotencyKey: `${prefix}-cancel` });
    expect(cancelled.status).toBe("CANCELLED");
    const reexport = await repoReexportAccountingBatch({ batchId: cancelled.id, body: { reason: "Réexport demandé après annulation logique" }, actor, idempotencyKey: `${prefix}-reexport` });
    expect(reexport.status).toBe("PREVIEWED");
    expect(reexport.reexport_of_batch_id).toBe(cancelled.id);

    await pool.query("UPDATE public.paiement SET updated_at=updated_at+interval '1 second' WHERE id=$1", [paymentId]);
    await expect(repoValidateAccountingBatch({ batchId: reexport.id, body: { expected_version: reexport.row_version }, actor, idempotencyKey: `${prefix}-stale-validate` })).rejects.toMatchObject({ code: "ACCOUNTING_EXPORT_PREVIEW_STALE" });

    const evidence = await pool.query<{ claims: number; audits: number }>(
      `SELECT (SELECT count(*)::int FROM public.accounting_export_source_claims WHERE batch_id=$1::uuid) AS claims,
              (SELECT count(*)::int FROM public.erp_audit_logs WHERE entity_type='accounting_export_batch' AND entity_id=$1::text) AS audits`,
      [generated.id]
    );
    expect(evidence.rows[0]).toMatchObject({ claims: 3 });
    expect(evidence.rows[0]!.audits).toBeGreaterThanOrEqual(3);
  });
});
