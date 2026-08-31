import { describe, expect, it } from "vitest";

import {
  createInventorySessionSchema,
  createArticleSchema,
  createLotGenealogySchema,
  createMovementSchema,
  postMovementSchema,
  upsertInventoryLineSchema,
  historicalImportSchema,
  listConsolidatedInventoryQuerySchema,
} from "./stock.validators";
import {
  createStockReservationSchema,
  consumeStockReservationSchema,
  stockReservationActionSchema,
} from "./stock-reservation.validators";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

describe("#225 stock validators", () => {
  it("requires Fourniture Client identification only for achat_transforme", () => {
    const base = {
      designation: "Brut fourni par le client",
      article_category: "achat",
      article_categories: ["achat_transforme"],
      family_code: "ACH",
    };

    expect(createArticleSchema.safeParse({ body: base }).success).toBe(false);
    expect(createArticleSchema.safeParse({
      body: {
        ...base,
        fourniture_client: { reference: "045/10", indice: "A", numero_client: "001" },
      },
    }).success).toBe(true);
    expect(createArticleSchema.safeParse({
      body: {
        ...base,
        article_categories: ["achat_revente"],
        fourniture_client: { reference: "045/10", indice: "A", numero_client: "001" },
      },
    }).success).toBe(false);
  });

  it("validates the OLD historical import contract and consolidated inventory filters", () => {
    expect(historicalImportSchema.safeParse({ body: {
      kind: "PF", client_number: "CLI-01", reference: "PLAN-42", designation: "Pièce reprise", quantity: 2,
      of_affaire_refs: ["OF-1"], mp_lot_refs: [], traitement_lot_refs: [],
    } }).success).toBe(true);
    expect(historicalImportSchema.safeParse({ body: {
      kind: "PF", client_number: "CLI-01", article_id: UUID_A, quantity: 2,
      of_affaire_refs: [], mp_lot_refs: [], traitement_lot_refs: [],
    } }).success).toBe(true);
    expect(historicalImportSchema.safeParse({ body: {
      kind: "PF", client_number: "CLI-01", quantity: 2,
      of_affaire_refs: [], mp_lot_refs: [], traitement_lot_refs: [],
    } }).success).toBe(false);
    expect(historicalImportSchema.safeParse({ body: {
      kind: "PF", client_number: "CLI-01", article_id: UUID_A, reference: "PLAN-42", designation: "Doublon", quantity: 2,
      of_affaire_refs: [], mp_lot_refs: [], traitement_lot_refs: [],
    } }).success).toBe(false);
    expect(historicalImportSchema.safeParse({ body: { kind: "MP", quantity: 1, lot_number: "F-1" } }).success).toBe(false);
    expect(historicalImportSchema.safeParse({ body: {
      kind: "MP", article_id: UUID_A, quantity: 1, lot_number: "F-1", unexpected: true,
    } }).success).toBe(false);
    expect(listConsolidatedInventoryQuerySchema.safeParse({ scope: "OLD", sortBy: "lot_code", sortDir: "desc" }).success).toBe(true);
    expect(listConsolidatedInventoryQuerySchema.safeParse({ scope: "ARCHIVE" }).success).toBe(false);
  });
  const movementCases: Array<{
    name: string;
    body: Record<string, unknown>;
    valid: boolean;
  }> = [
    {
      name: "inbound",
      body: {
        movement_type: "IN",
        lines: [{ article_id: UUID_A, qty: 1, dst_magasin_id: UUID_B, dst_emplacement_id: 1 }],
      },
      valid: true,
    },
    {
      name: "outbound",
      body: {
        movement_type: "OUT",
        lines: [{ article_id: UUID_A, qty: 1, src_magasin_id: UUID_B, src_emplacement_id: 1 }],
      },
      valid: true,
    },
    {
      name: "transfer",
      body: {
        movement_type: "TRANSFER",
        lines: [{
          article_id: UUID_A,
          qty: 1,
          src_magasin_id: UUID_B,
          src_emplacement_id: 1,
          dst_magasin_id: UUID_C,
          dst_emplacement_id: 2,
        }],
      },
      valid: true,
    },
    {
      name: "adjustment in",
      body: {
        movement_type: "ADJUSTMENT",
        lines: [{
          article_id: UUID_A,
          qty: 1,
          direction: "IN",
          dst_magasin_id: UUID_B,
          dst_emplacement_id: 1,
        }],
      },
      valid: true,
    },
    {
      name: "zero quantity",
      body: {
        movement_type: "IN",
        lines: [{ article_id: UUID_A, qty: 0, dst_magasin_id: UUID_B, dst_emplacement_id: 1 }],
      },
      valid: false,
    },
    {
      name: "negative quantity",
      body: {
        movement_type: "OUT",
        lines: [{ article_id: UUID_A, qty: -1, src_magasin_id: UUID_B, src_emplacement_id: 1 }],
      },
      valid: false,
    },
    {
      name: "missing source",
      body: { movement_type: "OUT", lines: [{ article_id: UUID_A, qty: 1 }] },
      valid: false,
    },
    {
      name: "missing destination",
      body: { movement_type: "IN", lines: [{ article_id: UUID_A, qty: 1 }] },
      valid: false,
    },
    {
      name: "mixed articles",
      body: {
        movement_type: "IN",
        lines: [
          { article_id: UUID_A, qty: 1, dst_magasin_id: UUID_B, dst_emplacement_id: 1 },
          { article_id: UUID_C, qty: 1, dst_magasin_id: UUID_B, dst_emplacement_id: 1 },
        ],
      },
      valid: false,
    },
    {
      name: "unknown key",
      body: {
        movement_type: "IN",
        bypass: true,
        lines: [{ article_id: UUID_A, qty: 1, dst_magasin_id: UUID_B, dst_emplacement_id: 1 }],
      },
      valid: false,
    },
  ];

  for (const testCase of movementCases) {
    it(`validates movement: ${testCase.name}`, () => {
      expect(
        createMovementSchema.safeParse({ body: testCase.body }).success
      ).toBe(testCase.valid);
    });
  }

  it("requires a bounded and justified negative-stock override", () => {
    expect(
      postMovementSchema.safeParse({
        body: {
          negative_stock_override: {
            maximum_negative_qty: 5,
            reason: "Arrêt de production évité",
          },
        },
      }).success
    ).toBe(true);
    expect(
      postMovementSchema.safeParse({
        body: {
          negative_stock_override: {
            maximum_negative_qty: 0,
            reason: "trop court",
          },
        },
      }).success
    ).toBe(false);
  });

  const inventoryCases: Array<{
    name: string;
    body: Record<string, unknown>;
    valid: boolean;
  }> = [
    { name: "magasin scope", body: { scope_magasin_id: UUID_A }, valid: true },
    { name: "article scope", body: { scope_article_id: UUID_A }, valid: true },
    { name: "article reference prefix", body: { scope_article_prefix: "160" }, valid: true },
    { name: "category scope", body: { scope_article_category: "matiere" }, valid: true },
    {
      name: "emplacement with parent",
      body: { scope_magasin_id: UUID_A, scope_emplacement_id: 1 },
      valid: true,
    },
    { name: "empty scope", body: {}, valid: false },
    { name: "orphan emplacement", body: { scope_emplacement_id: 1 }, valid: false },
    { name: "bad category", body: { scope_article_category: "autre" }, valid: false },
    { name: "unknown field", body: { scope_article_id: UUID_A, delete_history: true }, valid: false },
  ];

  for (const testCase of inventoryCases) {
    it(`validates inventory: ${testCase.name}`, () => {
      expect(
        createInventorySessionSchema.safeParse({ body: testCase.body }).success
      ).toBe(testCase.valid);
    });
  }

  it("validates count rounds, optimistic version and discrepancy metadata", () => {
    const base = {
      article_id: UUID_A,
      magasin_id: UUID_B,
      emplacement_id: 1,
      counted_qty: 2,
      expected_session_version: 1,
    };
    expect(upsertInventoryLineSchema.safeParse({ body: base }).success).toBe(true);
    expect(
      upsertInventoryLineSchema.safeParse({
        body: { ...base, count_round: 3 },
      }).success
    ).toBe(false);
    expect(
      upsertInventoryLineSchema.safeParse({
        body: { ...base, expected_session_version: 0 },
      }).success
    ).toBe(false);
    expect(
      upsertInventoryLineSchema.safeParse({
        body: {
          ...base,
          lot_id: UUID_C,
          of_references: ["OF-2026-001"],
          mp_references: ["MP-7075-001"],
          tr_references: ["TR-ANO-001"],
        },
      }).success
    ).toBe(true);
    expect(
      upsertInventoryLineSchema.safeParse({
        body: {
          ...base,
          lot_id: UUID_C,
          of_references: ["1", "2", "3", "4", "5"],
        },
      }).success
    ).toBe(false);
  });

  it("validates split, merge and transform genealogy shapes", () => {
    const contribution = (lot_id: string, qty: number) => ({ lot_id, qty });
    expect(
      createLotGenealogySchema.safeParse({
        body: {
          operation_type: "SPLIT",
          parents: [contribution(UUID_A, 2)],
          children: [contribution(UUID_B, 1), contribution(UUID_C, 1)],
          unit_code: "PC",
          stock_movement_id: UUID_A,
        },
      }).success
    ).toBe(true);
    expect(
      createLotGenealogySchema.safeParse({
        body: {
          operation_type: "MERGE",
          parents: [contribution(UUID_A, 1)],
          children: [contribution(UUID_B, 1)],
          unit_code: "PC",
          stock_movement_id: UUID_C,
        },
      }).success
    ).toBe(false);
  });

  it("requires a real business source for reservations", () => {
    const base = {
      article_id: UUID_A,
      magasin_id: UUID_B,
      emplacement_id: 1,
      qty: 2,
      reason: "Allocation commande",
    };
    expect(
      createStockReservationSchema.safeParse({
        body: {
          ...base,
          source: { source_type: "OF", of_id: 42 },
        },
      }).success
    ).toBe(true);
    expect(
      createStockReservationSchema.safeParse({
        body: {
          ...base,
          source: { source_type: "OF", source_id: "42" },
        },
      }).success
    ).toBe(false);
  });

  it("requires optimistic versions and a posted movement when consuming", () => {
    expect(
      stockReservationActionSchema.safeParse({
        body: { expected_version: 1, reason: "Commande annulée" },
      }).success
    ).toBe(true);
    expect(
      consumeStockReservationSchema.safeParse({
        body: {
          expected_version: 1,
          reason: "Préparation expédiée",
          stock_movement_id: UUID_A,
        },
      }).success
    ).toBe(true);
    expect(
      consumeStockReservationSchema.safeParse({
        body: {
          expected_version: 0,
          reason: "Préparation expédiée",
          stock_movement_id: "invalid",
        },
      }).success
    ).toBe(false);
  });
});
