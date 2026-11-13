import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { seedProductionWorkbenchFixture } from "../../../__tests__/fixtures/production-workbench.fixture";
import { loadApplicableTechnicalSnapshot } from "../domain/of-generation";
import { evaluateOfPreparation } from "./production-preparation.repository";
import { repoGenerateSelfInspection } from "./self-inspection.repository";

const managed = process.env.CERP_E2E_ISOLATED === "1" && process.env.CERP_E2E_MANAGED_STACK === "1";

describe.skipIf(!managed)("PT documents in a managed disposable workbench", () => {
  afterAll(() => pool.end());

  it("uses the chosen non-obsolete revision, keeps applicable fallback and requires published historical opt-in", async () => {
    const f = await seedProductionWorkbenchFixture();
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      async function version(status: "BROUILLON" | "APPLICABLE" | "OBSOLETE", futureDays = 0) {
        const id = randomUUID();
        const code = `QA-BOUNDARY-${id}`;
        await tx.query(`INSERT INTO public.piece_technique_versions
          SELECT (jsonb_populate_record(NULL::public.piece_technique_versions,
            to_jsonb(source) || jsonb_build_object('id',$2::text,'indice',$3::text,
              'indice_externe_original',$3::text,'code_metier',$4::text,'code_metier_normalise',$4::text,
              'statut',$5::text,'is_current',false,'date_effet',CURRENT_DATE+$6::int))).*
          FROM public.piece_technique_versions source WHERE source.id=$1::uuid`,
        [f.version, id, id.slice(0, 12), code, status, futureDays]);
        return id;
      }
      const chosen = await version("BROUILLON");
      const obsolete = await version("OBSOLETE");
      const futureDraft = await version("BROUILLON", 1);
      const snapshot = (id: string, historical = false) => loadApplicableTechnicalSnapshot(tx, f.piece, {
        pinned_version_id: id, allow_historical_published: historical,
      });
      expect((await snapshot(chosen)).version_id).toBe(chosen);
      expect((await loadApplicableTechnicalSnapshot(tx, f.piece)).version_id).toBe(f.version);
      await expect(snapshot(obsolete)).rejects.toMatchObject({ code: "VERSION_NOT_APPLICABLE" });
      expect((await snapshot(obsolete, true)).version_id).toBe(obsolete);
      await expect(snapshot(futureDraft)).rejects.toMatchObject({ code: "VERSION_NOT_APPLICABLE" });
      await expect(snapshot(futureDraft, true)).rejects.toMatchObject({ code: "VERSION_NOT_APPLICABLE" });
      // The database permits only one applicable revision per piece.
      await tx.query("UPDATE public.piece_technique_versions SET statut='OBSOLETE' WHERE id=$1::uuid", [f.version]);
      const futurePublished = await version("APPLICABLE", 1);
      await expect(snapshot(futurePublished)).rejects.toMatchObject({ code: "VERSION_NOT_APPLICABLE" });
      expect((await snapshot(futurePublished, true)).version_id).toBe(futurePublished);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("reuses the clean legacy template, prefers the explicitly linked revision and repeats improvement feedback on later OFs", async () => {
    const f = await seedProductionWorkbenchFixture();
    const tx = await pool.connect();
    async function attach(classKey: string, original: string, entity: string, linkId: string, role: string) {
      const id = randomUUID(), version = randomUUID(), session = randomUUID();
      await tx.query(`INSERT INTO public.ged_documents(id,code,class_key,title,created_by)
        VALUES($1,$2,$3,'Pièce de recette',$4)`, [id,"QA-"+id,classKey,f.audit.user_id]);
      await tx.query(`INSERT INTO public.ged_upload_sessions(id,class_key,document_id,title,status,sha256,size_bytes,mime_type,original_name,
        created_by,expires_at,scan_status,quarantine_status,scan_provider,signature_version,scan_duration_ms,scan_attempts,scanned_at)
        SELECT $1,$2,$3,'Recette','PUBLISHED',sha256,size_bytes,mime_type,$4,$5,now()+interval '1 day',
        'clean','released','isolated-e2e-scanner','TEST',1,1,now() FROM public.ged_blobs WHERE id='92000000-0000-4000-8000-000000000004'`,
        [session,classKey,id,original,f.audit.user_id]);
      await tx.query(`INSERT INTO public.ged_document_versions(id,document_id,version_number,status,blob_id,original_name,created_by,approved_by,approved_at,published_at,upload_session_id,created_at)
        VALUES($1,$2,1,'APPLICABLE','92000000-0000-4000-8000-000000000004',$3,$4,$4,now(),now(),$5,'2001-01-01')`, [version,id,original,f.audit.user_id,session]);
      await tx.query("UPDATE public.ged_documents SET current_version_id=$2 WHERE id=$1", [id,version]);
      await tx.query(`INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by) VALUES($1,$2,$3,$4,$5)`, [id,entity,linkId,role,f.audit.user_id]);
      return { id, version };
    }
    let expectedUpdatedAt: string;
    let exactId: string;
    try {
      await tx.query("BEGIN");
      const legacy = await attach("RELEVE_CONTROLE","Fiche_autocontrole.pdf","PIECE_TECHNIQUE",f.piece,"DOSSIER_TECHNIQUE");
      expect((await evaluateOfPreparation(tx,f.ids[0])).imported_inspection?.id).toBe(legacy.id);
      const exact = await attach("RELEVE_CONTROLE","Contrôles.pdf","PIECE_TECHNIQUE_VERSION",f.version,"FICHE_AUTOCONTROLE");
      const before = await evaluateOfPreparation(tx,f.ids[0]);
      exactId = exact.id;
      expectedUpdatedAt = before.of.updated_at;
      expect(before.imported_inspection?.id).toBe(exact.id);
      expect(before.items.find(i => i.key === "self_inspection")?.status).toBe("READY");
      const scan = await attach("GAMME_DOC","Retour.pdf","PIECE_TECHNIQUE",f.piece,"FICHE_AMELIORATION");
      for (const ofId of f.ids) {
        const data = await evaluateOfPreparation(tx,ofId);
        expect(data.improvement_returns.map(doc => doc.version_id)).toEqual([scan.version]);
        expect(data.items.find(i => i.key === "index_review")?.required).toBe(false);
      }
      const after = await evaluateOfPreparation(tx,f.ids[0]);
      expect(after.source_hash).toBe(before.source_hash);
      // Consolidation re-reads the evidence from the JSONB snapshot after the quality visa.
      const persisted = (await tx.query("SELECT $1::jsonb AS evidence", [JSON.stringify(after.sources)])).rows[0].evidence;
      const snapshotFor = (evidence: unknown) => loadApplicableTechnicalSnapshot(tx, f.piece, {
        pinned_version_id: f.version, preparation_evidence: evidence,
      });
      expect((await snapshotFor(persisted)).sha256).toBe((await snapshotFor(after.sources)).sha256);
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    const reused = await repoGenerateSelfInspection(f.ids[0],expectedUpdatedAt,f.audit);
    expect(reused.imported_inspection?.id).toBe(exactId);
    expect(reused.sheet).toBeNull();
  });
});
