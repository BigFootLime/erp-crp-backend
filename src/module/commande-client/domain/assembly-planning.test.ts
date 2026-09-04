import { beforeEach, describe, expect, it, vi } from "vitest";

const generation = vi.hoisted(() => ({
  loadApplicableTechnicalSnapshot: vi.fn(),
  loadFabricationGenerationTree: vi.fn(),
}));

vi.mock("../../production/domain/of-generation", () => generation);

import {
  computeCommandeSupplyPlanHash,
  createAssemblyPlanningLedger,
  planAssemblyRequirements,
} from "./assembly-planning";

const ids = {
  rootArticle: "11111111-1111-4111-8111-111111111111",
  rootPiece: "22222222-2222-4222-8222-222222222222",
  rootVersion: "33333333-3333-4333-8333-333333333333",
  childArticle: "44444444-4444-4444-8444-444444444444",
  childPiece: "55555555-5555-4555-8555-555555555555",
  childVersion: "66666666-6666-4666-8666-666666666666",
  bomLine: "77777777-7777-4777-8777-777777777777",
};

describe("planAssemblyRequirements", () => {
  beforeEach(() => {
    generation.loadApplicableTechnicalSnapshot.mockReset();
    generation.loadFabricationGenerationTree.mockReset();
  });

  it("keeps a SIMPLE finished article as a single production need", async () => {
    const tx = {
      query: vi.fn(async () => ({
        rows: [{
          id: ids.rootVersion,
          statut: "APPLICABLE",
          effective: true,
          manufacturing_mode: "SIMPLE",
          assembly_supply_strategy: "MAKE_TO_ORDER",
        }],
      })),
    };

    const plan = await planAssemblyRequirements(tx as never, {
      root_article_id: ids.rootArticle,
      root_piece_technique_id: ids.rootPiece,
      root_piece_technique_version_id: ids.rootVersion,
      quantity: 12,
      due_date: "2026-09-30",
    });

    expect(plan).toMatchObject({
      manufacturing_mode: "SIMPLE",
      technical_status: "READY",
      assembly_qty: 12,
      quantity_to_assemble: 12,
      components: [],
      planned_of_quantities_by_path: {},
    });
    expect(plan.supply_plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(generation.loadFabricationGenerationTree).not.toHaveBeenCalled();
  });

  it("uses OLD then NEW and creates a child OF only for the fabricated shortage", async () => {
    generation.loadFabricationGenerationTree.mockResolvedValue([
      {
        key: ids.rootPiece,
        parent_key: null,
        bom_line_id: null,
        parent_piece_technique_id: null,
        piece_technique_id: ids.rootPiece,
        article_id: ids.rootArticle,
        code_piece: "PF-100",
        designation: "Article fini assemblé",
        version_number: 1,
        level: 0,
        ordre_affichage: 0,
        quantite_par_parent: 1,
        quantite_cumulee: 1,
      },
      {
        key: `${ids.rootPiece}/${ids.childPiece}`,
        parent_key: ids.rootPiece,
        bom_line_id: ids.bomLine,
        parent_piece_technique_id: ids.rootPiece,
        piece_technique_id: ids.childPiece,
        article_id: ids.childArticle,
        code_piece: "SF-200",
        designation: "Sous-ensemble fabriqué",
        version_number: 1,
        level: 1,
        ordre_affichage: 1,
        quantite_par_parent: 1,
        quantite_cumulee: 1,
      },
    ]);
    generation.loadApplicableTechnicalSnapshot.mockResolvedValue({ version_id: ids.childVersion });

    const tx = {
      query: vi.fn(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes("FROM public.piece_technique_versions")) {
          return { rows: [{
            id: ids.rootVersion,
            statut: "APPLICABLE",
            effective: true,
            manufacturing_mode: "ASSEMBLY",
            assembly_supply_strategy: "MAKE_TO_ORDER",
          }] };
        }
        if (text.includes("FROM public.articles article") && text.includes("piece_technique_id = ANY")) {
          return { rows: [{
            piece_technique_id: ids.childPiece,
            article_id: ids.childArticle,
            article_code: "ART-SF-200",
            designation: "Sous-ensemble fabriqué",
          }] };
        }
        if (text.includes("FROM public.v_stock_availability_225")) {
          return { rows: [
            { article_id: ids.childArticle, piece_technique_version_id: ids.childVersion, stock_scope: "OLD", qty_available: 2 },
            { article_id: ids.childArticle, piece_technique_version_id: ids.childVersion, stock_scope: "NEW", qty_available: 3 },
          ] };
        }
        if (text.includes("FROM public.pieces_techniques_nomenclature line")) return { rows: [] };
        return { rows: [] };
      }),
    };

    const plan = await planAssemblyRequirements(tx as never, {
      root_article_id: ids.rootArticle,
      root_piece_technique_id: ids.rootPiece,
      root_piece_technique_version_id: ids.rootVersion,
      quantity: 10,
      due_date: "2026-09-30",
    });

    expect(plan.components).toEqual([
      expect.objectContaining({
        kind: "FABRICATED",
        article_id: ids.childArticle,
        old_used_qty: 2,
        new_used_qty: 3,
        shortage_qty: 5,
        action: "CREATE_CHILD_OF",
      }),
    ]);
    expect(plan.planned_of_quantities_by_path).toEqual({
      [ids.rootPiece]: 10,
      [`${ids.rootPiece}/${ids.childPiece}`]: 5,
    });
  });

  it("shares internal-contract capacity across order lines and plans only the uncovered remainder", async () => {
    generation.loadFabricationGenerationTree.mockResolvedValue([
      {
        key: ids.rootPiece,
        parent_key: null,
        bom_line_id: null,
        parent_piece_technique_id: null,
        piece_technique_id: ids.rootPiece,
        article_id: ids.rootArticle,
        code_piece: "PF-100",
        designation: "Article fini assemblÃ©",
        version_number: 1,
        level: 0,
        ordre_affichage: 0,
        quantite_par_parent: 1,
        quantite_cumulee: 1,
      },
    ]);
    const tx = {
      query: vi.fn(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes("FROM public.piece_technique_versions")) {
          return { rows: [{
            id: ids.rootVersion,
            statut: "APPLICABLE",
            effective: true,
            manufacturing_mode: "ASSEMBLY",
            assembly_supply_strategy: "INTERNAL_CONTRACT",
          }] };
        }
        if (text.includes("FROM public.ordres_fabrication fabrication")) {
          return { rows: [{
            of_id: 70,
            of_numero: "OF-2026-000070",
            available_date: "2026-09-20",
            remaining_qty: 6,
          }] };
        }
        return { rows: [] };
      }),
    };
    const ledger = createAssemblyPlanningLedger();

    const first = await planAssemblyRequirements(tx as never, {
      root_article_id: ids.rootArticle,
      root_piece_technique_id: ids.rootPiece,
      root_piece_technique_version_id: ids.rootVersion,
      quantity: 4,
      due_date: "2026-09-30",
      ledger,
    });
    const second = await planAssemblyRequirements(tx as never, {
      root_article_id: ids.rootArticle,
      root_piece_technique_id: ids.rootPiece,
      root_piece_technique_version_id: ids.rootVersion,
      quantity: 5,
      due_date: "2026-09-30",
      ledger,
    });

    expect(first.contract_allocations).toEqual([
      expect.objectContaining({ of_id: 70, quantity: 4 }),
    ]);
    expect(first.quantity_to_assemble).toBe(0);
    expect(first.planned_of_quantities_by_path).toEqual({});
    expect(second.contract_allocations).toEqual([
      expect.objectContaining({ of_id: 70, quantity: 2 }),
    ]);
    expect(second.contract_covered_qty).toBe(2);
    expect(second.quantity_to_assemble).toBe(3);
    expect(second.planned_of_quantities_by_path).toEqual({ [ids.rootPiece]: 3 });
    expect(second.warnings).toContain("INTERNAL_CONTRACT_REMAINDER_REQUIRED");
  });
});

describe("computeCommandeSupplyPlanHash", () => {
  it("binds the launch request to the exact per-line supply analysis", () => {
    const first = computeCommandeSupplyPlanHash([{ commande_ligne_id: 10, assembly_plan: null }]);
    const replay = computeCommandeSupplyPlanHash([{ commande_ligne_id: 10, assembly_plan: null }]);
    const changed = computeCommandeSupplyPlanHash([{ commande_ligne_id: 11, assembly_plan: null }]);

    expect(first).toBe(replay);
    expect(first).not.toBe(changed);
  });
});
