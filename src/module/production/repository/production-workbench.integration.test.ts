import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoReusePreparationStock } from "./preparation-stock-reuse.repository";
import { reconcileReleasedConsolidationLot } from "./production-receipts.repository";
import { createRecursiveOrdresFabrication } from "../domain/of-generation";
import { synchronizeDraftChildrenTx } from "./preparation-children.repository";
import { repoSaveProgrammingTask } from "./preparation-actions.repository";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PLANNED_OPERATION_DURATION_MINUTES_SQL } from "../domain/planned-operation-duration";
import pool from "../../../config/database";
import { repoProductionWorklist } from "./production-worklist.repository";
import {
  evaluateOfPreparation,
  repoSavePreparationDecisions,
  repoReviewPreparationStock,
} from "./production-preparation.repository";
import { repoGenerateSelfInspection } from "./self-inspection.repository";
import {
  repoCreateOrdreFabrication,
  repoSubmitOfTechnicalPreparation,
  repoValidateOfTechnicalPreparation,
} from "./production.repository";
import {
  repoCreateConsolidation,
  repoPreviewConsolidation,
  repoGetConsolidation,
  repoDissolveConsolidation,
} from "./production-consolidation.repository";
import {
  seedProductionWorkbenchFixture,
  seedWorkbenchStock,
} from "../../../__tests__/fixtures/production-workbench.fixture";
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.DATABASE_URL ===
    "postgresql://cerp_712@127.0.0.1:55432/cerp_test";
async function prepareFixture(
  f: Awaited<ReturnType<typeof seedProductionWorkbenchFixture>>,
) {
  let e = await evaluateOfPreparation(pool, f.ids[0]);
  const decisions = {
    material: {
      mode: "NOT_REQUIRED" as const,
      reason: "Matière fournie pour cet essai",
    },
    treatment: {
      mode: "NOT_REQUIRED" as const,
      reason: "Aucun traitement prévu",
    },
    subcontract: {
      mode: "NOT_REQUIRED" as const,
      reason: "Fabrication interne",
    },
    programming: {
      mode: "NONE" as const,
      reason: "Opération manuelle de démonstration",
    },
  };
  await repoSavePreparationDecisions(
    f.ids[0],
    {
      expected_updated_at: e.of.updated_at,
      version_id: f.version,
      expected_version: e.profile_version,
      decisions,
    },
    f.audit,
  );
  for (const id of f.ids.slice(0, 2)) {
    e = await evaluateOfPreparation(pool, id);
    e = await repoReviewPreparationStock(
      id,
      {
        expected_updated_at: e.of.updated_at,
        source_hash: e.stock_hash,
        reason: "Aucun stock de démonstration disponible",
      },
      f.audit,
    );
    e = await repoGenerateSelfInspection(id, e.of.updated_at, f.audit);
    await repoSubmitOfTechnicalPreparation({
      id,
      body: { expected_updated_at: e.of.updated_at },
      audit: f.audit,
    });
    e = await evaluateOfPreparation(pool, id);
    await repoValidateOfTechnicalPreparation({
      id,
      body: { expected_updated_at: e.of.updated_at },
      audit: f.audit,
    });
  }
}
describe.skipIf(!isolated)(
  "Production workbench — real isolated PostgreSQL",
  () => {
    let fixture: Awaited<ReturnType<typeof seedProductionWorkbenchFixture>>;
    beforeAll(async () => {
      fixture = await seedProductionWorkbenchFixture();
    });
    afterAll(async () => {
      await pool.end();
    });
    it("applies the initial migration with populated OF rows and deferred constraints", async () => {
      await pool.query("UPDATE public.ordres_fabrication SET planning_wait_started_at=NULL WHERE id=$1", [fixture.ids[0]]);
      const sql = readFileSync(resolve(process.cwd(), "db/patches/20260905_production_preparation_consolidation_01.sql"), "utf8")
        .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(sql);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        const result = await tx.query("SELECT planning_wait_started_at=created_at AS backfilled FROM public.ordres_fabrication WHERE id=$1", [fixture.ids[0]]);
        expect(result.rows[0].backfilled).toBe(true);
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    });
    it("offers and accepts secondary programming roles but rejects unassigned or inactive users", async () => {
      const f = await seedProductionWorkbenchFixture();
      const username = `E2E712-PROGRAMMER-${randomUUID()}`;
      const user = (await pool.query("INSERT INTO public.users(username,password,role,status,email) VALUES($1,'DISABLED_TEST_CREDENTIAL','Employee','Active',$2) RETURNING id", [username, `${username}@example.invalid`])).rows[0].id;
      let e = await evaluateOfPreparation(pool, f.ids[0]);
      const input = () => ({ expected_updated_at: e.of.updated_at, assignee_id: user, estimated_hours: 2, status: "TODO" as const });
      expect(e.programmers).not.toEqual(expect.arrayContaining([expect.objectContaining({id:user})]));
      await expect(repoSaveProgrammingTask(f.ids[0], input(), f.audit)).rejects.toMatchObject({code:"PROGRAMMER_REQUIRED"});
      await pool.query("INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,'Programmation')", [user]);
      e = await evaluateOfPreparation(pool, f.ids[0]);
      expect(e.programmers).toEqual(expect.arrayContaining([expect.objectContaining({id:user})]));
      await repoSaveProgrammingTask(f.ids[0], input(), f.audit);
      const f2 = await seedProductionWorkbenchFixture();
      await pool.query("UPDATE public.users SET status='Inactive' WHERE id=$1", [user]);
      const inactive = await evaluateOfPreparation(pool, f2.ids[0]);
      expect(inactive.programmers).not.toEqual(expect.arrayContaining([expect.objectContaining({id:user})]));
      await expect(repoSaveProgrammingTask(f2.ids[0], {...input(),expected_updated_at:inactive.of.updated_at}, f2.audit)).rejects.toMatchObject({code:"PROGRAMMER_REQUIRED"});
    });
    it("returns the same active population in counters and unfiltered total", async () => {
      const result = await repoProductionWorklist({
        q: "",
        kind: "ALL",
        queue: "ALL",
        page: 1,
        pageSize: 100,
      });
      expect(Number(result.total)).toBe((result.counts as { ALL: number }).ALL);
      expect(Array.isArray(result.items)).toBe(true);
    });
    it("evaluates real draft definitions and stock without invented evidence", async () => {
      const ids = (
        await pool.query<{ id: number }>(
          "SELECT id::bigint::int FROM public.ordres_fabrication ORDER BY id LIMIT 5",
        )
      ).rows;
      expect(ids.length).toBeGreaterThan(0);
      for (const { id } of ids) {
        const result = await evaluateOfPreparation(pool, id);
        expect(result.items.length).toBe(13);
        expect(result.source_hash).toHaveLength(64);
        expect(result.stock_hash).toHaveLength(64);
        expect(
          (await evaluateOfPreparation(pool, fixture.ids[0])).shared_impact
            .mutable_of_ids,
        ).toEqual(expect.arrayContaining(fixture.ids));
      }
    });
    it("preserves a manually created draft's priority, dates and notes", async () => {
      const f = await seedProductionWorkbenchFixture({ draft: true });
      const created = await repoCreateOrdreFabrication({
        body: {
          piece_technique_id: f.piece,
          piece_technique_version_id: f.version,
          client_id: "901",
          quantite_lancee: 7,
          priority: "HIGH",
          statut: "BROUILLON",
          date_lancement_prevue: "2026-09-10",
          date_fin_prevue: "2026-09-20",
          notes: "Échéance impérative de démonstration",
        },
        audit: f.audit,
      });
      const row = (
        await pool.query(
          "SELECT priority::text,date_lancement_prevue::text,date_fin_prevue::text,notes,technical_snapshot_sha256 FROM public.ordres_fabrication WHERE id=$1",
          [created.id],
        )
      ).rows[0];
      expect(row).toMatchObject({
        priority: "HIGH",
        date_lancement_prevue: "2026-09-10",
        date_fin_prevue: "2026-09-20",
        notes: "Échéance impérative de démonstration",
        technical_snapshot_sha256: null,
      });
    });
    it("materializes draft assembly children once and reconciles changed quantities transactionally", async () => {
      const child = await seedProductionWorkbenchFixture({ draft: true });
      const assembly = await seedProductionWorkbenchFixture({
        draft: true,
        child,
      });
      const tx = await pool.connect();
      await tx.query("BEGIN");
      try {
        const generated = await createRecursiveOrdresFabrication(tx, {
          source_type: "MANUAL",
          commande_id: null,
          commande_numero: null,
          commande_ligne_id: null,
          livraison_affaire_id: null,
          client_id: "901",
          root_article_id: assembly.article,
          root_piece_technique_id: assembly.piece,
          root_pinned_version_id: assembly.version,
          qty_to_produce: 7,
          user_id: assembly.audit.user_id,
        });
        expect(generated.ofs).toHaveLength(2);
        const sub = generated.ofs.find((o) => o.parent_of_id !== null)!;
        expect(sub.operations_count).toBe(0);
        const first = (
          await tx.query(
            "SELECT quantite_lancee::float8 AS qty,technical_snapshot_sha256 FROM public.ordres_fabrication WHERE id=$1",
            [sub.id],
          )
        ).rows[0];
        expect(first.qty).toBe(14);
        expect(first.technical_snapshot_sha256).toBeNull();
        await synchronizeDraftChildrenTx(
          tx,
          generated.root_of_id,
          assembly.audit.user_id,
        );
        expect(
          Number(
            (
              await tx.query(
                "SELECT count(*) FROM public.ordres_fabrication WHERE parent_of_id=$1",
                [generated.root_of_id],
              )
            ).rows[0].count,
          ),
        ).toBe(1);
        await tx.query(
          "UPDATE public.pieces_techniques_nomenclature SET quantite=3 WHERE parent_piece_technique_version_id=$1::uuid",
          [assembly.version],
        );
        await synchronizeDraftChildrenTx(
          tx,
          generated.root_of_id,
          assembly.audit.user_id,
        );
        expect(
          (
            await tx.query(
              "SELECT quantite_lancee::float8 AS qty FROM public.ordres_fabrication WHERE id=$1",
              [sub.id],
            )
          ).rows[0].qty,
        ).toBe(21);
        expect(
          (
            await tx.query(
              "SELECT required_qty::float8 AS qty FROM public.of_component_requirements WHERE consuming_of_id=$1",
              [generated.root_of_id],
            )
          ).rows[0].qty,
        ).toBe(21);
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    });
    it("saves programming and common decisions atomically and rejects a stale profile", async () => {
      const f = await seedProductionWorkbenchFixture();
      let e = await evaluateOfPreparation(pool, f.ids[0]);
      const input = {
        expected_updated_at: e.of.updated_at,
        expected_profile_version: e.profile_version,
        assignee_id: f.audit.user_id,
        estimated_hours: 2,
        status: "TODO" as const,
        decisions: {
          material: {
            mode: "NOT_REQUIRED" as const,
            reason: "Matière fournie",
          },
        },
      };
      e = await repoSaveProgrammingTask(f.ids[0], input, f.audit);
      expect(e.decisions.material?.reason).toBe("Matière fournie");
      expect(e.programming_task?.estimated_hours).toBe(2);
      await expect(
        repoSaveProgrammingTask(
          f.ids[1],
          {
            ...input,
            expected_updated_at: (await evaluateOfPreparation(pool, f.ids[1]))
              .of.updated_at,
            expected_task_updated_at: e.programming_task!.updated_at,
          },
          f.audit,
        ),
      ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
      expect(
        (await evaluateOfPreparation(pool, f.ids[1])).programming_task
          ?.estimated_hours,
      ).toBe(2);
    });
    it("creates real surplus assembly components and restores the original requirements on dissolution", async () => {
      const child = await seedProductionWorkbenchFixture({ draft: true });
      const assembly = await seedProductionWorkbenchFixture({ child });
      await prepareFixture(assembly);
      const sources = await Promise.all(
        assembly.ids.slice(0, 2).map(async (of_id) => ({
          of_id,
          expected_updated_at: (await evaluateOfPreparation(pool, of_id)).of
            .updated_at,
        })),
      );
      const request = {
        sources,
        surplus_quantity: 5,
        reason: "Assemblage et stock supplémentaire",
      };
      const preview = await repoPreviewConsolidation(request);
      const group = await repoCreateConsolidation(
        {
          request,
          preview_hash: preview.preview_hash,
          idempotency_key: randomUUID(),
        },
        assembly.audit,
      );
      const reqs = (
        await pool.query(
          "SELECT consuming_of_id,component_of_id,required_qty::float8 FROM public.of_component_requirements WHERE consuming_of_id=$1 AND status<>'CANCELLED'",
          [group.producer_of_id],
        )
      ).rows;
      expect(reqs).toHaveLength(3);
      expect(reqs.reduce((sum, r) => sum + r.required_qty, 0)).toBe(70);
      expect(reqs.every((r) => r.component_of_id)).toBe(true);
      const extras = (
        await pool.query(
          "SELECT surplus_of_ids FROM public.production_consolidations WHERE id=$1::uuid",
          [group.id],
        )
      ).rows[0].surplus_of_ids;
      expect(extras).toHaveLength(1);
      const details = await repoGetConsolidation(group.id);
      await repoDissolveConsolidation(
        group.id,
        {
          expected_updated_at: details.producer_updated_at,
          reason: "Restitution des besoins initiaux",
        },
        assembly.audit,
      );
      expect(
        (
          await pool.query(
            "SELECT statut FROM public.ordres_fabrication WHERE id=$1",
            [extras[0]],
          )
        ).rows[0].statut,
      ).toBe("ANNULE");
      expect(
        Number(
          (
            await pool.query(
              "SELECT sum(required_qty) AS qty FROM public.of_component_requirements WHERE consuming_of_id=ANY($1::bigint[]) AND status<>'CANCELLED'",
              [assembly.ids.slice(0, 2)],
            )
          ).rows[0].qty,
        ),
      ).toBe(60);
    });
    it.each([
      {
        scope: "NEW" as const,
        withQuality: true,
        status: "LIBERE",
        error: null,
      },
      {
        scope: "OLD" as const,
        withQuality: false,
        status: "LIBERE",
        error: null,
      },
      {
        scope: "NEW" as const,
        withQuality: false,
        status: "LIBERE",
        error: "QUALITY_NOT_ELIGIBLE",
      },
      {
        scope: "OLD" as const,
        withQuality: false,
        status: "QUARANTAINE",
        error: "STOCK_REUSE_QUANTITY",
      },
    ])(
      "reserves the exact component demand once with scope=$scope quality=$withQuality status=$status",
      async (policy) => {
        const child = await seedProductionWorkbenchFixture();
        const parent = await seedProductionWorkbenchFixture({
          draft: true,
          child,
          componentQuantity: 1,
        });
        const tx = await pool.connect();
        await tx.query("BEGIN");
        let childId: number;
        try {
          await synchronizeDraftChildrenTx(
            tx,
            parent.ids[2],
            parent.audit.user_id,
          );
          childId = Number(
            (
              await tx.query(
                "SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1",
                [parent.ids[2]],
              )
            ).rows[0].id,
          );
          await tx.query("COMMIT");
        } catch (e) {
          await tx.query("ROLLBACK");
          throw e;
        } finally {
          tx.release();
        }
        const previousVersion = randomUUID();
        await pool.query(
          `INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,date_revision,version_interne,code_metier,code_metier_normalise) VALUES($1::uuid,$2::uuid,'0',$3,'BROUILLON',false,now()-interval '90 days',2,$3,$3)`,
          [previousVersion, child.piece, child.code + "-OLD"],
        );
        const stock = await seedWorkbenchStock(
          { ...child, version: previousVersion },
          8,
          policy.status,
          policy,
        );
        let e = await evaluateOfPreparation(pool, childId!);
        expect(e.stock_candidates.some((l) => l.lot_id === stock.lot)).toBe(
          policy.status === "LIBERE",
        );
        const input = {
          expected_updated_at: e.of.updated_at,
          source_hash: e.stock_hash,
          lot_id: stock.lot,
          stock_batch_id: stock.batch,
          quantity: 3,
          disposition: "REUSE" as const,
          justification: "Compatibilité dimensionnelle vérifiée",
          approval_reference: "Validation technique E2E-712",
          idempotency_key: randomUUID(),
        };
        if (policy.error) {
          await expect(
            repoReusePreparationStock(childId!, input, child.audit),
          ).rejects.toMatchObject({ code: policy.error });
          expect(
            (await evaluateOfPreparation(pool, childId!)).of.quantite_lancee,
          ).toBe(8);
          expect(
            (
              await pool.query(
                "SELECT id FROM public.stock_reservations WHERE lot_id=$1::uuid",
                [stock.lot],
              )
            ).rows,
          ).toHaveLength(0);
          return;
        }
        e = await repoReusePreparationStock(childId!, input, child.audit);
        expect(e.of.quantite_lancee).toBe(5);
        e = await repoReusePreparationStock(childId!, input, child.audit);
        expect(e.of.quantite_lancee).toBe(5);
        const sync = await pool.connect();
        await sync.query("BEGIN");
        try {
          await synchronizeDraftChildrenTx(
            sync,
            parent.ids[2],
            parent.audit.user_id,
          );
          expect(
            Number(
              (
                await sync.query(
                  "SELECT quantite_lancee FROM public.ordres_fabrication WHERE id=$1",
                  [childId!],
                )
              ).rows[0].quantite_lancee,
            ),
          ).toBe(5);
          await sync.query("COMMIT");
        } catch (error) {
          await sync.query("ROLLBACK");
          throw error;
        } finally {
          sync.release();
        }
        const reservation = (
          await pool.query(
            "SELECT qty_reserved::float8,source_scope,of_component_requirement_id FROM public.stock_reservations WHERE lot_id=$1::uuid",
            [stock.lot],
          )
        ).rows;
        expect(reservation).toHaveLength(1);
        expect(reservation[0].qty_reserved).toBe(3);
        expect(reservation[0].source_scope).toBe(policy.scope);
        expect(reservation[0].of_component_requirement_id).toBeTruthy();
        expect(
          (
            await pool.query(
              "SELECT piece_technique_version_id::text FROM public.lots WHERE id=$1::uuid",
              [stock.lot],
            )
          ).rows[0].piece_technique_version_id,
        ).toBe(previousVersion);
        e = await evaluateOfPreparation(pool, childId!);
        e = await repoReusePreparationStock(
          childId!,
          {
            ...input,
            expected_updated_at: e.of.updated_at,
            source_hash: e.stock_hash,
            quantity: 5,
            idempotency_key: randomUUID(),
          },
          child.audit,
        );
        expect(e.of.statut).toBe("ANNULE");
        const fullCover = await pool.connect();
        await fullCover.query("BEGIN");
        try {
          await synchronizeDraftChildrenTx(
            fullCover,
            parent.ids[2],
            parent.audit.user_id,
          );
          expect(
            (
              await fullCover.query(
                "SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1 AND statut<>'ANNULE'",
                [parent.ids[2]],
              )
            ).rows,
          ).toHaveLength(0);
          expect(
            Number(
              (
                await fullCover.query(
                  "SELECT sum(qty_reserved) AS quantity FROM public.stock_reservations WHERE lot_id=$1::uuid AND status='ACTIVE'",
                  [stock.lot],
                )
              ).rows[0].quantity,
            ),
          ).toBe(8);
          await fullCover.query("COMMIT");
        } catch (error) {
          await fullCover.query("ROLLBACK");
          throw error;
        } finally {
          fullCover.release();
        }
      },
    );
    it("allocates quarantined receipts only after release and never duplicates the physical stock entry", async () => {
      const f = await seedProductionWorkbenchFixture();
      await prepareFixture(f);
      const sources = await Promise.all(
        f.ids.slice(0, 2).map(async (of_id) => ({
          of_id,
          expected_updated_at: (await evaluateOfPreparation(pool, of_id)).of
            .updated_at,
        })),
      );
      const request = {
        sources,
        surplus_quantity: 5,
        reason: "Réception différée après libération qualité",
      };
      const preview = await repoPreviewConsolidation(request);
      const group = await repoCreateConsolidation(
        {
          request,
          preview_hash: preview.preview_hash,
          idempotency_key: randomUUID(),
        },
        f.audit,
      );
      const stock = await seedWorkbenchStock(f, 35, "QUARANTAINE");
      const movement = randomUUID();
      const tx = await pool.connect();
      await tx.query("BEGIN");
      try {
        await tx.query(
          "UPDATE public.stock_levels SET qty_total=0 WHERE id=$1::uuid",
          [stock.level],
        );
        await tx.query(
          "UPDATE public.stock_batches SET qty_total=0 WHERE id=$1::uuid",
          [stock.batch],
        );
        await tx.query(
          `INSERT INTO public.stock_movements(id,movement_no,movement_type,status,article_id,stock_level_id,stock_batch_id,qty,source_document_type,source_document_id,posted_at,posted_by) VALUES($1::uuid,$2,'IN','POSTED',$3::uuid,$4::uuid,$5::uuid,35,'OF',$6,now(),$7)`,
          [
            movement,
            f.code,
            f.article,
            stock.level,
            stock.batch,
            String(group.producer_of_id),
            f.audit.user_id,
          ],
        );
        await tx.query(
          `INSERT INTO public.of_receipts(of_id,actor_user_id,idempotency_key,request_hash,request_payload,result_payload,expected_of_updated_at,qty_ok,quality_status,quality_reason,location_id,lot_id,stock_level_id,stock_batch_id,stock_movement_id)
        VALUES($1,$2,$3,$4,'{}','{}',now(),35,'QUARANTAINE','Attente de libération qualité',$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid)`,
          [
            group.producer_of_id,
            f.audit.user_id,
            randomUUID(),
            "a".repeat(64),
            stock.location,
            stock.lot,
            stock.level,
            stock.batch,
            movement,
          ],
        );
        await reconcileReleasedConsolidationLot(tx, stock.lot, f.audit.user_id);
        expect(
          Number(
            (
              await tx.query(
                "SELECT sum(received_quantity) AS qty FROM public.production_consolidation_allocations WHERE consolidation_id=$1::uuid",
                [group.id],
              )
            ).rows[0].qty,
          ),
        ).toBe(0);
        await tx.query(
          "UPDATE public.lots SET lot_status='LIBERE' WHERE id=$1::uuid",
          [stock.lot],
        );
        await tx.query(
          "UPDATE public.quality_control SET qty_released=10 WHERE id=$1::uuid",
          [stock.quality],
        );
        await reconcileReleasedConsolidationLot(tx, stock.lot, f.audit.user_id);
        await reconcileReleasedConsolidationLot(tx, stock.lot, f.audit.user_id);
        expect(
          Number(
            (
              await tx.query(
                "SELECT sum(received_quantity) AS qty FROM public.production_consolidation_allocations WHERE consolidation_id=$1::uuid",
                [group.id],
              )
            ).rows[0].qty,
          ),
        ).toBe(10);
        await tx.query(
          "UPDATE public.quality_control SET qty_released=35 WHERE id=$1::uuid",
          [stock.quality],
        );
        await reconcileReleasedConsolidationLot(tx, stock.lot, f.audit.user_id);
        await reconcileReleasedConsolidationLot(tx, stock.lot, f.audit.user_id);
        expect(
          Number(
            (
              await tx.query(
                "SELECT sum(received_quantity) AS qty FROM public.production_consolidation_allocations WHERE consolidation_id=$1::uuid",
                [group.id],
              )
            ).rows[0].qty,
          ),
        ).toBe(30);
        expect(
          Number(
            (
              await tx.query(
                "SELECT count(*) FROM public.production_consolidation_receipt_allocations WHERE movement_id=$1::uuid",
                [movement],
              )
            ).rows[0].count,
          ),
        ).toBe(2);
        expect(
          Number(
            (
              await tx.query(
                "SELECT qty_total FROM public.stock_batches WHERE id=$1::uuid",
                [stock.batch],
              )
            ).rows[0].qty_total,
          ),
        ).toBe(35);
        expect(
          Number(
            (
              await tx.query(
                "SELECT count(*) FROM public.stock_movements WHERE id=$1::uuid",
                [movement],
              )
            ).rows[0].count,
          ),
        ).toBe(1);
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    });
    it("prepares shared evidence, generates PDF, freezes sources, consolidates once and restores demand", async () => {
      const id = fixture.ids[0];
      let e = await evaluateOfPreparation(pool, id);
      const decisions = {
        material: {
          mode: "NOT_REQUIRED" as const,
          reason: "Matière fournie pour cet essai",
        },
        treatment: {
          mode: "NOT_REQUIRED" as const,
          reason: "Aucun traitement prévu",
        },
        subcontract: {
          mode: "NOT_REQUIRED" as const,
          reason: "Fabrication interne",
        },
        programming: {
          mode: "NONE" as const,
          reason: "Opération manuelle de démonstration",
        },
      };
      await repoSavePreparationDecisions(
        id,
        {
          expected_updated_at: e.of.updated_at,
          version_id: fixture.version,
          expected_version: e.profile_version,
          decisions,
        },
        fixture.audit,
      );
      for (const ofId of fixture.ids.slice(0, 2)) {
        e = await evaluateOfPreparation(pool, ofId);
        expect(e.shared_ready).toBe(true);
        e = await repoReviewPreparationStock(
          ofId,
          {
            expected_updated_at: e.of.updated_at,
            source_hash: e.stock_hash,
            reason: "Aucun stock dans cette fixture",
          },
          fixture.audit,
        );
        e = await repoGenerateSelfInspection(
          ofId,
          e.of.updated_at,
          fixture.audit,
        );
        expect(e.ready).toBe(true);
        expect(e.sheet?.state).toBe("READY");
        await repoSubmitOfTechnicalPreparation({
          id: ofId,
          body: { expected_updated_at: e.of.updated_at },
          audit: fixture.audit,
        });
        e = await evaluateOfPreparation(pool, ofId);
        await repoValidateOfTechnicalPreparation({
          id: ofId,
          body: { expected_updated_at: e.of.updated_at },
          audit: fixture.audit,
        });
        e = await evaluateOfPreparation(pool, ofId);
        expect(e.ready).toBe(true);
        expect(e.of.technical_readiness).toBe("VALIDATED");
      }
      const sources = await Promise.all(
        fixture.ids.slice(0, 2).map(async (of_id) => ({
          of_id,
          expected_updated_at: (await evaluateOfPreparation(pool, of_id)).of
            .updated_at,
        })),
      );
      const request = {
        sources,
        surplus_quantity: 5,
        reason: "Démonstration : besoins confirmés et cinq pièces de stock",
      };
      const preview = await repoPreviewConsolidation(request);
      expect(preview.quantity).toBe(35);
      const input = {
        request,
        preview_hash: preview.preview_hash,
        idempotency_key: randomUUID(),
      };
      expect(preview.workload.producer_minutes).toBe(531);
      expect(preview.workload.separate_minutes).toBe(462);
      const results = await Promise.all([
        repoCreateConsolidation(input, fixture.audit),
        repoCreateConsolidation(input, fixture.audit),
      ]);
      const group = results[0];
      expect(results[1].producer_of_id).toBe(group.producer_of_id);
      expect(results.filter((r) => r.idempotent_replay)).toHaveLength(1);
      const producer = await evaluateOfPreparation(pool, group.producer_of_id);
      expect(producer.ready).toBe(true);
      expect(producer.sheet?.id).not.toBe(e.sheet?.id);
      const operations = (
        await pool.query(
          `SELECT op.qte::float8,${PLANNED_OPERATION_DURATION_MINUTES_SQL} AS minutes FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id WHERE op.of_id=$1`,
          [group.producer_of_id],
        )
      ).rows;
      expect(operations[0].qte).toBe(1);
      expect(operations[0].minutes).toBe(531);
      await expect(
        pool.query(
          `UPDATE public.ordres_fabrication SET quantite_lancee=99 WHERE id=$1`,
          [group.producer_of_id],
        ),
      ).rejects.toThrow("CONSOLIDATION_QUANTITY_LOCKED");
      await expect(
        pool.query(
          `UPDATE public.ordres_fabrication SET statut='PLANIFIE' WHERE id=$1`,
          [id],
        ),
      ).rejects.toThrow("OF_COVERED_BY_CONSOLIDATION");
      const poste = randomUUID();
      await pool.query(
        "INSERT INTO public.postes(id,code,label,is_active) VALUES($1::uuid,$2,'Poste de recette préparation',true)",
        [poste, fixture.code],
      );
      const event = (
        await pool.query(
          `INSERT INTO public.planning_events(id,of_id,of_operation_id,poste_id,title,start_ts,end_ts,allow_overlap,created_by) SELECT gen_random_uuid(),$1,op.id,$2::uuid,'Recette du producteur',now()+interval '1 day',now()+interval '1 day 9 hours',true,$3 FROM public.of_operations op WHERE op.of_id=$1 RETURNING id::text`,
          [group.producer_of_id, poste, fixture.audit.user_id],
        )
      ).rows;
      expect(event).toHaveLength(1);
      const planned = await repoProductionWorklist({
        q: producer.of.numero,
        queue: "PLANNED",
        kind: "ALL",
        page: 1,
        pageSize: 25,
      });
      expect(planned.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: group.producer_of_id,
            planning_state: "COMPLETE",
            overdue: false,
            queue: "PLANNED",
          }),
        ]),
      );
      const engagedDetails = await repoGetConsolidation(group.id);
      await expect(
        repoDissolveConsolidation(
          group.id,
          {
            expected_updated_at: engagedDetails.producer_updated_at,
            reason: "Dissolution interdite pendant planning",
          },
          fixture.audit,
        ),
      ).rejects.toMatchObject({ code: "CONSOLIDATION_ENGAGED" });
      await pool.query(
        "UPDATE public.planning_events SET status='CANCELLED' WHERE id=$1::uuid",
        [event[0].id],
      );
      const unplanned = await repoProductionWorklist({
        q: producer.of.numero,
        queue: "OVERDUE",
        kind: "ALL",
        page: 1,
        pageSize: 25,
      });
      expect(unplanned.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: group.producer_of_id,
            queue: "READY",
            overdue: true,
          }),
        ]),
      );
      const details = await repoGetConsolidation(group.id);
      await repoDissolveConsolidation(
        group.id,
        {
          expected_updated_at: details.producer_updated_at,
          reason: "Restitution de démonstration",
        },
        fixture.audit,
      );
      expect((await repoGetConsolidation(group.id)).state).toBe("DISSOLVED");
      expect(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM public.production_consolidation_allocations WHERE source_of_id=ANY($1::bigint[]) AND state='ACTIVE'`,
              [fixture.ids],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    });
  },
);
