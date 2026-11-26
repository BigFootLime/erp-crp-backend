import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { seedProductionWorkbenchFixture, seedWorkbenchStock } from "../../../__tests__/fixtures/production-workbench.fixture";
import { loadApplicableTechnicalSnapshot } from "../domain/of-generation";
import { evaluateOfPreparation, repoReviewPreparationStock, repoSavePreparationDecisions } from "./production-preparation.repository";
import { repoPrepareOperationProgramming } from "./preparation-actions.repository";
import { repoSubmitOfTechnicalPreparation, repoValidateOfTechnicalPreparation } from "./production.repository";
import { repoGenerateSelfInspection } from "./self-inspection.repository";
import { repoCreateGammeRevision } from "../../gammes/repository/gammes.repository";
import { repoCreateGammeOperation, repoListGammeOperations, repoPublishGamme, repoUpdateGammeOperation } from "../../gammes/repository/gamme-operations.repository";
import { readOperationQualifications } from "../../planning/repository/planning-operation-resources.repository";
import { assertOperationResourceCompatible } from "../../planning/repository/planning.repository";
import { readPlanningProcurementTx } from "../../planning/repository/planning-procurement.repository";
import { readCentralSnapshot } from "../../planning/repository/planning-central.repository";
import { addAchatSVC, updateAchatSVC } from "../../pieces-techniques/services/pieces-techniques.service";
import { addAchatSchema } from "../../pieces-techniques/validators/pieces-techniques.validators";
import { confirmStockFinishArticleSVC, previewStockFinishArticleSVC } from "../../surface-finish/services/surface-finish.service";
import { stockArticleFinishConfirmBodySchema, stockArticleFinishPreviewBodySchema } from "../../surface-finish/validators/surface-finish.validators";
import { repoValidateArticle } from "../../stock/repository/stock-article-lifecycle.repository";

const managed = process.env.CERP_E2E_ISOLATED === "1" && process.env.CERP_E2E_MANAGED_STACK === "1";

describe.skipIf(!managed)("PT documents in a managed disposable workbench", () => {
  afterAll(() => pool.end());

  it("reuses unchanged no-programming and no-stock decisions and preserves them through OF validation", async () => {
    const f = await seedProductionWorkbenchFixture();
    const [originalId, repeatId, reviewId, newIndexId] = f.ids;
    await pool.query("UPDATE public.pieces_techniques_operations SET numero_programme='QA-CNC' WHERE gamme_id=$1", [f.gamme]);
    let original = await evaluateOfPreparation(pool, originalId);
    original = await repoSavePreparationDecisions(originalId, {
      expected_updated_at: original.of.updated_at, version_id: f.version, expected_version: original.profile_version,
      decisions: {
        treatment: { mode: "NOT_REQUIRED", reason: "Aucun procédé pour cette pièce" },
        subcontract: { mode: "NOT_REQUIRED", reason: "Fabrication interne" },
      },
    }, f.audit);
    const [operation] = original.programming_operations;
    original = await repoPrepareOperationProgramming(originalId, {
      expected_updated_at: original.of.updated_at, operation_id: operation.operation_id, operation_hash: operation.operation_hash,
      mode: "NOT_REQUIRED", reason: "Un programme existant est disponible", estimated_hours: 0,
    }, f.audit);
    original = await repoReviewPreparationStock(originalId, {
      expected_updated_at: original.of.updated_at, source_hash: original.stock_hash, reason: "Aucun lot disponible",
    }, f.audit);
    await repoValidateOfTechnicalPreparation({ id: originalId, body: { expected_updated_at: original.of.updated_at }, audit: f.audit });
    const frozenOriginal = await evaluateOfPreparation(pool, originalId);

    const repeat = await evaluateOfPreparation(pool, repeatId);
    expect(repeat.of.quantite_lancee).not.toBe(original.of.quantite_lancee);
    expect(repeat.stock_candidates).toEqual([]);
    expect(repeat.stock_review).toMatchObject({ decision: "NO_REUSE", inherited_from_of_id: originalId, source_hash: repeat.stock_hash });
    expect(repeat.items).toContainEqual(expect.objectContaining({ key: "stock_compatibility", status: "READY" }));
    expect(repeat.programming_operations[0]).toMatchObject({ status: "NOT_REQUIRED", inherited_from_of_id: originalId });
    expect(repeat.of.technical_preparation?.operation_programming).toBeUndefined();
    await repoValidateOfTechnicalPreparation({ id: repeatId, body: { expected_updated_at: repeat.of.updated_at }, audit: f.audit });
    const frozenRepeat = await evaluateOfPreparation(pool, repeatId);
    expect(frozenRepeat.of.technical_snapshot_sha256).toBeTruthy();
    expect(frozenRepeat.stock_review?.inherited_from_of_id).toBe(originalId);
    expect((await pool.query("SELECT decision,source_hash FROM public.of_stock_reviews WHERE of_id=$1", [repeatId])).rows[0])
      .toEqual({ decision: "NO_REUSE", source_hash: repeat.stock_hash });
    expect(frozenRepeat.of.technical_preparation?.operation_programming?.[operation.operation_id])
      .toMatchObject({ mode: "NOT_REQUIRED", inherited_from_of_id: originalId });

    const draft = await repoCreateGammeRevision(f.gamme, {}, f.audit, randomUUID());
    const [copied] = await repoListGammeOperations(draft.gamme.id);
    await pool.query("UPDATE public.ordres_fabrication SET technical_preparation=technical_preparation||jsonb_build_object('selected_gamme_id',$2::text) WHERE id=$1", [reviewId, draft.gamme.id]);
    const copiedUnchanged = await evaluateOfPreparation(pool, reviewId);
    expect(copiedUnchanged.programming_operations[0]).toMatchObject({
      operation_id: copied.id, status: "NOT_REQUIRED", inherited_from_of_id: originalId,
    });
    await repoUpdateGammeOperation(draft.gamme.id, copied.id, { numero_programme: "QA-CHANGED", expected_updated_at: copied.updated_at }, f.audit);
    await seedWorkbenchStock(f, 4);
    const changed = await evaluateOfPreparation(pool, reviewId);
    expect(changed.programming_operations[0]).toMatchObject({ status: "TODO" });
    expect(changed.stock_review).toBeNull();
    expect(changed.items).toContainEqual(expect.objectContaining({ key: "stock_compatibility", status: "MISSING" }));

    const versionId = randomUUID(), versionCode = `${f.code}-B`;
    await pool.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,
      date_revision,version_interne,code_metier,code_metier_normalise) VALUES($1,$2,'B',$3,'BROUILLON',false,now(),2,$3,$3)`, [versionId, f.piece, versionCode]);
    await pool.query("UPDATE public.ordres_fabrication SET technical_preparation=technical_preparation||jsonb_build_object('selected_version_id',$2::text) WHERE id=$1", [newIndexId, versionId]);
    expect((await evaluateOfPreparation(pool, newIndexId)).inherited_preparation).toEqual({ programming: {}, stock_review: null });
    expect((await evaluateOfPreparation(pool, originalId)).of.technical_snapshot_sha256).toBe(frozenOriginal.of.technical_snapshot_sha256);
  });

  it("uses a new treatment phase linked from purchases in the current OF and its planning only after validation", async () => {
    const f = await seedProductionWorkbenchFixture();
    const [id, other, locked, otherVersionOrder] = f.ids;
    await pool.query("UPDATE public.pieces_techniques_operations SET numero_programme='QA-CNC' WHERE gamme_id=$1", [f.gamme]);
    const finish = randomUUID(), revision = randomUUID();
    const finishTitle = `Anodisation de recette ${finish.slice(0, 8)}`;
    const family = (await pool.query("SELECT code FROM public.surface_finish_families WHERE label='Anodisation'")).rows[0].code;
    await pool.query(`INSERT INTO public.surface_finishes(id,code,family_code,procede,designation_courte,statut)
      VALUES($1,$2,$3,'Anodisation',$4,'ACTIVE')`, [finish, `FIN-${randomInt(100_000, 999_999)}`, family, finishTitle]);
    await pool.query(`INSERT INTO public.surface_finish_revisions(id,finish_id,revision,statut,norme,unite_achat)
      VALUES($1,$2,1,'ACTIVE','ISO 7599','PCE')`, [revision, finish]);
    await pool.query("UPDATE public.surface_finishes SET current_revision_id=$2 WHERE id=$1", [finish, revision]);
    const actor = { user_id: f.audit.user_id, role: f.audit.user_role ?? null };
    const spec = stockArticleFinishPreviewBodySchema.parse({
      piece_technique_id: f.piece, piece_technique_version_id: f.version, finish_revision_id: revision,
    });
    const preview = await previewStockFinishArticleSVC(spec, actor);
    const issued = await confirmStockFinishArticleSVC(stockArticleFinishConfirmBodySchema.parse({
      ...spec, decision: "CREATE", preview_hash: preview.preview_hash, spec_fingerprint: preview.spec_fingerprint,
    }), f.audit, actor, randomUUID());
    const articleId = issued.article.id;
    const article = (await pool.query("SELECT row_version::int FROM public.articles WHERE id=$1", [articleId])).rows[0];
    await repoValidateArticle(articleId, { expected_row_version: article.row_version }, f.audit);
    const before = await evaluateOfPreparation(pool, id);
    const draft = await repoCreateGammeRevision(f.gamme, {}, f.audit, randomUUID());
    const op = await repoCreateGammeOperation(draft.gamme.id, {
      numero_operation: 20, designation: "Procédé à rattacher", type_operation: "SOUS_TRAITANCE", temps_unitaire_minutes: 0,
    }, f.audit);
    const body = addAchatSchema.parse({ body: {
      type_achat: "TRAITEMENT", article_id: articleId, designation: issued.article.designation,
      nom: issued.article.designation, quantite: 1, unite_prix: "PCE",
      fournisseur_id: "50000000-0000-4000-8000-000000000001",
      piece_technique_version_id: f.version, gamme_operation_id: op.id,
      preparation_of: { id, expected_updated_at: before.of.updated_at },
    } }).body;
    const foreign = await seedProductionWorkbenchFixture();
    const foreignOrder = await evaluateOfPreparation(pool, foreign.ids[0]);
    await expect(addAchatSVC(f.piece, {
      ...body, preparation_of: { id: foreign.ids[0], expected_updated_at: foreignOrder.of.updated_at },
    }, f.audit)).rejects.toMatchObject({ code: "PURCHASE_OF_MISMATCH" });
    const otherVersionId = randomUUID();
    const otherVersionCode = `${f.code}-B`;
    await pool.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,
      date_revision,version_interne,code_metier,code_metier_normalise)
      VALUES($1,$2,'B',$3,'BROUILLON',false,now(),2,$3,$3)`, [otherVersionId, f.piece, otherVersionCode]);
    await pool.query(`UPDATE public.ordres_fabrication
      SET technical_preparation=technical_preparation||jsonb_build_object('selected_version_id',$2::text) WHERE id=$1`,
    [otherVersionOrder, otherVersionId]);
    const otherVersion = await evaluateOfPreparation(pool, otherVersionOrder);
    await expect(addAchatSVC(f.piece, {
      ...body, preparation_of: { id: otherVersionOrder, expected_updated_at: otherVersion.of.updated_at },
    }, f.audit)).rejects.toMatchObject({ code: "PURCHASE_OF_VERSION_CHANGED" });
    await pool.query("UPDATE public.ordres_fabrication SET technical_readiness='VALIDATED' WHERE id=$1", [locked]);
    const lockedOrder = await evaluateOfPreparation(pool, locked);
    await expect(addAchatSVC(f.piece, {
      ...body, preparation_of: { id: locked, expected_updated_at: lockedOrder.of.updated_at },
    }, f.audit)).rejects.toMatchObject({ code: "OF_PREPARATION_LOCKED" });
    const purchase = await addAchatSVC(f.piece, body, f.audit);
    expect(purchase?.gamme_operation_id).toBe(op.id);
    const updated = await evaluateOfPreparation(pool, id);
    expect(updated.gamme_id).toBe(draft.gamme.id);
    expect(updated.sources.operations).toContainEqual(expect.objectContaining({ id: op.id, phase: 20, designation: finishTitle }));
    expect(updated.sources.purchases).toContainEqual(expect.objectContaining({ id: purchase?.id, gamme_operation_id: op.id }));
    const otherOrder = await evaluateOfPreparation(pool, other);
    expect(otherOrder.gamme_id).toBe(f.gamme);
    expect(otherOrder.sources.purchases).not.toContainEqual(expect.objectContaining({ id: purchase?.id }));
    expect((await loadApplicableTechnicalSnapshot(pool, f.piece)).gamme_id).toBe(f.gamme);
    await expect(addAchatSVC(f.piece, body, f.audit)).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect((await repoListGammeOperations(draft.gamme.id)).filter(operation => operation.phase === 20)).toHaveLength(1);
    await updateAchatSVC(f.piece, purchase!.id!, {
      gamme_operation_id: op.id, preparation_of: { id, expected_updated_at: updated.of.updated_at },
    }, f.audit);
    expect((await pool.query("SELECT count(*)::int AS total FROM public.pieces_techniques_achats WHERE gamme_operation_id=$1", [op.id])).rows[0].total).toBe(1);

    const reviewed = await repoSavePreparationDecisions(id, {
      expected_updated_at: updated.of.updated_at, version_id: f.version, expected_version: updated.profile_version,
      decisions: {
        material: { mode: "REQUIRED" }, treatment: { mode: "REQUIRED" },
        subcontract: { mode: "NOT_REQUIRED", reason: "Usinage interne" },
        programming: { mode: "NONE", reason: "Programme déjà disponible" },
      },
    }, f.audit);
    const withSheet = await repoGenerateSelfInspection(id, reviewed.of.updated_at, f.audit);
    await repoSubmitOfTechnicalPreparation({ id, body: { expected_updated_at: withSheet.of.updated_at }, audit: f.audit });
    const submitted = await evaluateOfPreparation(pool, id);
    await repoValidateOfTechnicalPreparation({ id, body: { expected_updated_at: submitted.of.updated_at }, audit: f.audit });
    const frozen = await evaluateOfPreparation(pool, id);
    expect(frozen.of.technical_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.gamme_id).toBe(draft.gamme.id);
    await expect(addAchatSVC(f.piece, {
      ...body, preparation_of: { id, expected_updated_at: frozen.of.updated_at },
    }, f.audit)).rejects.toMatchObject({ code: "OF_PREPARATION_LOCKED" });
    expect((await evaluateOfPreparation(pool, id)).of.technical_snapshot_sha256).toBe(frozen.of.technical_snapshot_sha256);
    const executed = (await pool.query("SELECT id::text FROM public.of_operations WHERE of_id=$1 AND phase=20", [id])).rows[0];
    expect(executed?.id).toBeTruthy();
    expect((await readPlanningProcurementTx(pool, id)).entries).toContainEqual(expect.objectContaining({
      kind: "PRESTATION", articleId, operationId: executed.id,
    }));
    const planning = await readCentralSnapshot({
      from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86400000).toISOString(),
      of_id: id, placement: "backlog", limit: 25,
    }, undefined, false);
    expect(planning.tasks).toContainEqual(expect.objectContaining({
      operationId: executed.id, view: "external", readiness: "READY",
    }));
  });

  it("keeps the old routing by choice and inherits machine choices, programming and the improvement flag on the next OF", async () => {
    const f = await seedProductionWorkbenchFixture();
    await pool.query(`UPDATE public.pieces_techniques_operations SET numero_programme='QA-CNC' WHERE gamme_id=$1`, [f.gamme]);
    const machines = [randomUUID(), randomUUID()];
    const oldMachine = randomUUID();
    for (const id of [oldMachine, ...machines]) {
      await pool.query(`INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by)
        VALUES($1,$2,$3,'MILLING','ACTIVE',true,'F',$4,$4)`, [id,`QA-${id}`,`Fraiseuse ${id.slice(0,4)}`,f.audit.user_id]);
    }
    const oldPoste = randomUUID();
    await pool.query(`INSERT INTO public.postes(id,code,label,machine_id,is_active)
      VALUES($1,$2,'Ancien poste',$3,true)`, [oldPoste,`QA-${oldPoste}`,oldMachine]);
    await pool.query(`UPDATE public.pieces_techniques_operations SET machine_id=$2,poste_id=$3 WHERE gamme_id=$1`,
      [f.gamme, oldMachine, oldPoste]);
    const first = await repoCreateGammeRevision(f.gamme, {}, f.audit, randomUUID());
    const [legacy] = await repoListGammeOperations(first.gamme.id);
    expect(legacy.poste_id).toBe(oldPoste);
    const changed = await repoUpdateGammeOperation(first.gamme.id, legacy.id, {
      machine_ids: machines, expected_updated_at: legacy.updated_at,
    }, f.audit);
    expect(changed.poste_id).toBeNull();
    expect(changed.machine_ids).toEqual(machines);
    await expect(repoUpdateGammeOperation(first.gamme.id, legacy.id, {
      machine_family_code: "T", numero_programme: "TURN1", expected_updated_at: changed.updated_at,
    }, f.audit)).rejects.toMatchObject({ code: "MACHINE_FAMILY_MISMATCH" });
    await expect(repoCreateGammeOperation(first.gamme.id, {
      designation: "Sans aucune qualification", type_operation: "FRAISAGE", machine_ids: [], temps_unitaire_minutes: 2,
    }, f.audit)).rejects.toMatchObject({ code: "MACHINE_COST_CENTER_REQUIRED" });
    const lathe = randomUUID();
    await pool.query(`INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by)
      VALUES($1,$2,'Tour QA','TURNING','ACTIVE',true,'T',$3,$3)`, [lathe,`QA-${lathe}`,f.audit.user_id]);
    await expect(repoCreateGammeOperation(first.gamme.id, {
      designation: "Machines incompatibles", type_operation: "FRAISAGE", machine_ids: [machines[0], lathe], temps_unitaire_minutes: 2,
    }, f.audit)).rejects.toMatchObject({ code: "MACHINE_COST_CENTER_REQUIRED" });
    const operation = await repoCreateGammeOperation(first.gamme.id, {
      numero_operation: 20, designation: "Ébauche QA", type_operation: "FRAISAGE",
      cf_id: f.cf, machine_ids: machines, numero_programme: "QA-20",
      temps_preparation_minutes: 5, temps_unitaire_minutes: 2,
      programmation_minutes: 90, amelioration_continue: "Revoir le bridage",
    }, f.audit);
    expect(operation.machine_ids).toEqual(machines);
    expect(operation.machine_names).toHaveLength(2);
    const timestamp = async (id: string) => (await pool.query<{updated_at:string}>(
      "SELECT updated_at::text FROM public.gammes WHERE id=$1", [id],
    )).rows[0].updated_at;
    async function validatePrepared(id: number) {
      const evaluated = await evaluateOfPreparation(pool, id);
      const reviewed = await repoSavePreparationDecisions(id, {
        expected_updated_at: evaluated.of.updated_at,
        version_id: f.version,
        expected_version: evaluated.profile_version,
        decisions: {
          material: { mode: "REQUIRED" },
          treatment: { mode: "NOT_REQUIRED", reason: "Aucun traitement prévu" },
          subcontract: { mode: "NOT_REQUIRED", reason: "Fabrication interne" },
        },
      }, f.audit);
      await repoSubmitOfTechnicalPreparation({
        id, body: { expected_updated_at: reviewed.of.updated_at }, audit: f.audit,
      });
      const submitted = await evaluateOfPreparation(pool, id);
      await repoValidateOfTechnicalPreparation({
        id, body: { expected_updated_at: submitted.of.updated_at }, audit: f.audit,
      });
      return evaluateOfPreparation(pool, id);
    }
    await repoPublishGamme(first.gamme.id, await timestamp(first.gamme.id), f.audit, false);
    const existing = await evaluateOfPreparation(pool, f.ids[0]);
    expect(existing.gamme_id).toBe(f.gamme);
    expect(existing.improvement_flags).toEqual([]);
    expect((await loadApplicableTechnicalSnapshot(pool, f.piece)).gamme_id).toBe(first.gamme.id);
    const oldFrozen = await validatePrepared(f.ids[1]);
    expect(oldFrozen.gamme_id).toBe(f.gamme);
    expect(oldFrozen.of.technical_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);

    const second = await repoCreateGammeRevision(first.gamme.id, {}, f.audit, randomUUID());
    await repoPublishGamme(second.gamme.id, await timestamp(second.gamme.id), f.audit, true);
    const refreshed = await evaluateOfPreparation(pool, f.ids[0]);
    expect(refreshed.gamme_id).toBe(second.gamme.id);
    expect(refreshed.programming_operations).toContainEqual(expect.objectContaining({ designation: "Ébauche QA", estimated_hours: 1.5, status: "PREPARED" }));
    expect(refreshed.improvement_flags).toEqual([expect.objectContaining({ phase: 20, note: "Revoir le bridage" })]);
    expect(refreshed.resource_preparation).toContainEqual(expect.objectContaining({ phase: 20, issue: null }));
    const retained = await evaluateOfPreparation(pool, f.ids[1]);
    expect(retained.gamme_id).toBe(f.gamme);
    expect(retained.of.technical_snapshot_sha256).toBe(oldFrozen.of.technical_snapshot_sha256);
    const flagId = refreshed.improvement_flags[0].id;
    const frozen = await validatePrepared(f.ids[0]);
    const receipt = await pool.query("SELECT of_id::int FROM public.gamme_improvement_receipts WHERE flag_id=$1", [flagId]);
    expect(receipt.rows).toEqual([{ of_id: f.ids[0] }]);
    expect((await evaluateOfPreparation(pool, f.ids[2])).improvement_flags).toEqual([]);
    expect(frozen.of.technical_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    const planned = await pool.query<{id:string}>(
      "SELECT id::text FROM public.of_operations WHERE of_id=$1 AND phase=20", [f.ids[0]],
    );
    const [qualified] = await readOperationQualifications(pool, [planned.rows[0].id], {});
    expect(qualified.eligible).toEqual(machines.map(id => `machine:${id}`).sort());
    const compatible = (id: string) => assertOperationResourceCompatible({
      tx: pool, of_operation_id: planned.rows[0].id, resource: { machine_id: id, poste_id: null },
    });
    await expect(compatible(machines[0])).resolves.toBeUndefined();
    await expect(compatible(oldMachine)).rejects.toMatchObject({ code: "PLANNING_MACHINE_NOT_SELECTED" });
  });

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
              'version_interne',(SELECT COALESCE(max(existing.version_interne),0)+1
                FROM public.piece_technique_versions existing WHERE existing.piece_technique_id=source.piece_technique_id),
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
