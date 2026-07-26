// #142 — Automatisation « sortie matière comptabilisée → consommation OF ».
//
// Ce maillon est le cœur de la traçabilité amont : sans lui, aucune preuve ne
// relie un lot matière à l'OF qui l'a consommé. Les tests vérifient qu'il est
// transactionnel, idempotent, borné aux vraies sorties, et qu'il compense au
// lieu de corriger.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordMaterialConsumptionOnPost } from "../module/traceability/services/material-consumption.automation";

type Handler = (sql: string, params: unknown[]) => { rows: unknown[] } | undefined;

function makeClient(handler: Handler) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: String(sql), params });
    return handler(String(sql), params) ?? { rows: [] };
  });
  return { client: { query }, calls, query };
}

const MOVEMENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const REVERSED_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const LINE_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const ARTICLE_ID = "cccccccc-0000-4000-8000-000000000001";
const LOT_ID = "dddddddd-0000-4000-8000-000000000001";

function head(overrides: Record<string, unknown> = {}) {
  return {
    movement_type: "OUT",
    status: "POSTED",
    source_document_type: "OF",
    source_document_id: "42",
    effective_at: "2026-07-20T10:00:00.000Z",
    reversal_of_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#142 consommation matière — périmètre", () => {
  it("enregistre la consommation d'une sortie déclarant un OF existant", async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        return { rows: [{ id: "cons-1" }, { id: "cons-2" }] };
      }
      return undefined;
    });

    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 7,
      correlationId: "eeeeeeee-0000-4000-8000-000000000001",
    });

    expect(result.recorded).toBe(2);
    expect(result.skipped_reason).toBeNull();
    const insert = calls.find((c) => c.sql.includes("INSERT INTO public.of_material_consumptions"));
    expect(insert).toBeDefined();
    // Idempotence garantie au niveau SQL, pas par une vérification préalable
    // qui laisserait une fenêtre de course.
    expect(insert?.sql).toContain("ON CONFLICT (stock_movement_line_id) DO NOTHING");
    // Les valeurs viennent de la ligne de mouvement, jamais du client HTTP.
    expect(insert?.sql).toContain("FROM public.stock_movement_lines sl");
  });

  it("ignore une entrée de stock (une entrée ne consomme rien)", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head({ movement_type: "IN" })] };
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.recorded).toBe(0);
    expect(result.skipped_reason).toBe("not_an_of_material_issue");
  });

  it("ignore un transfert interne", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "TRANSFER" })] };
      }
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.recorded).toBe(0);
  });

  it("prend en compte une sortie de type SCRAP (le rebut consomme la matière)", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "SCRAP" })] };
      }
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) return { rows: [{ id: "c" }] };
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.recorded).toBe(1);
  });

  it("ignore un mouvement non comptabilisé", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head({ status: "DRAFT" })] };
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("movement_not_posted");
    expect(result.recorded).toBe(0);
  });

  it("ignore une sortie sans référence documentaire d'OF", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ source_document_type: "BON_LIVRAISON" })] };
      }
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("not_an_of_material_issue");
  });

  it("refuse une référence d'OF qui n'est pas un identifiant valide", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ source_document_id: "OF-2026-0042" })] };
      }
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("not_an_of_material_issue");
  });

  it("refuse d'enregistrer une consommation vers un OF inexistant", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [] };
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("declared_of_not_found");
    expect(result.recorded).toBe(0);
  });

  it("ignore un mouvement introuvable", async () => {
    const { client } = makeClient(() => ({ rows: [] }));
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("movement_not_found");
  });
});

describe("#142 consommation matière — robustesse", () => {
  it("ne bloque pas la comptabilisation si la table n'existe pas encore", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        const err = new Error("relation does not exist") as Error & { code: string };
        err.code = "42P01";
        throw err;
      }
      return undefined;
    });

    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("traceability_table_unavailable");
  });

  it("ne bloque pas la comptabilisation sur un refus de droit PostgreSQL", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        const err = new Error("permission denied") as Error & { code: string };
        err.code = "42501";
        throw err;
      }
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    expect(result.skipped_reason).toBe("traceability_table_unavailable");
  });

  it("propage une vraie erreur SQL au lieu de la masquer", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        const err = new Error("deadlock detected") as Error & { code: string };
        err.code = "40P01";
        throw err;
      }
      return undefined;
    });
    await expect(
      recordMaterialConsumptionOnPost(client, {
        movementId: MOVEMENT_ID,
        actorUserId: 1,
        correlationId: null,
      })
    ).rejects.toThrow(/deadlock/i);
  });

  it("rattache la réservation consommée quand elle existe (preuve la plus forte)", async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) return { rows: [head()] };
      if (sql.includes("FROM public.ordres_fabrication")) return { rows: [{ id: "42" }] };
      if (sql.includes("INSERT INTO public.of_material_consumptions")) return { rows: [{ id: "c" }] };
      return undefined;
    });
    await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 1,
      correlationId: null,
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO public.of_material_consumptions"));
    expect(insert?.sql).toContain("consumed_stock_movement_id");
    expect(insert?.sql).toContain("RESERVATION_CONSUME");
  });
});

describe("#142 consommation matière — compensation", () => {
  it("marque les consommations d'origine COMPENSATED et n'en efface aucune", async () => {
    const updates: string[] = [];
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "IN", reversal_of_id: REVERSED_ID })] };
      }
      if (sql.includes("FROM public.of_material_consumptions c") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "orig-1",
              of_id: "42",
              article_id: ARTICLE_ID,
              lot_id: LOT_ID,
              unit_code: "kg",
            },
          ],
        };
      }
      if (sql.includes("FROM public.stock_movement_lines sl")) {
        return { rows: [{ id: LINE_ID, qty: "60", unite: "kg" }] };
      }
      if (sql.includes("UPDATE public.of_material_consumptions")) {
        updates.push(sql);
        return { rows: [] };
      }
      return undefined;
    });

    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 3,
      correlationId: null,
    });

    expect(result.compensated).toBe(1);
    expect(updates.join("\n")).toContain("'COMPENSATED'");
    // Aucune suppression : la preuve d'origine reste.
    expect(updates.join("\n")).not.toMatch(/DELETE/i);
  });

  it("crée une ligne de compensation quand le contre-mouvement porte la même paire article/lot", async () => {
    const inserts: string[] = [];
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "IN", reversal_of_id: REVERSED_ID })] };
      }
      if (sql.includes("FROM public.of_material_consumptions c") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ id: "orig-1", of_id: "42", article_id: ARTICLE_ID, lot_id: LOT_ID, unit_code: "kg" }],
        };
      }
      if (sql.includes("FROM public.stock_movement_lines sl")) {
        return { rows: [{ id: LINE_ID, qty: "60", unite: "kg" }] };
      }
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        inserts.push(sql);
        return { rows: [] };
      }
      return undefined;
    });

    await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 3,
      correlationId: null,
    });

    expect(inserts.join("\n")).toContain("'COMPENSATION'");
    expect(inserts.join("\n")).toContain("compensates_id");
  });

  it("ne devine pas une correspondance quand plusieurs lignes pourraient convenir", async () => {
    const inserts: string[] = [];
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "IN", reversal_of_id: REVERSED_ID })] };
      }
      if (sql.includes("FROM public.of_material_consumptions c") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ id: "orig-1", of_id: "42", article_id: ARTICLE_ID, lot_id: LOT_ID, unit_code: "kg" }],
        };
      }
      if (sql.includes("FROM public.stock_movement_lines sl")) {
        // Deux candidats : ambigu, donc AUCUNE correspondance retenue.
        return {
          rows: [
            { id: LINE_ID, qty: "30", unite: "kg" },
            { id: "bbbbbbbb-0000-4000-8000-000000000002", qty: "30", unite: "kg" },
          ],
        };
      }
      if (sql.includes("INSERT INTO public.of_material_consumptions")) {
        inserts.push(sql);
        return { rows: [] };
      }
      return undefined;
    });

    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 3,
      correlationId: null,
    });

    expect(inserts).toHaveLength(0);
    // La consommation d'origine est quand même marquée compensée : l'effet
    // stock a bien été annulé, seul le rattachement fin est indéterminé.
    expect(result.compensated).toBe(1);
  });

  it("ne compense rien si le mouvement d'origine n'avait produit aucune consommation", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "IN", reversal_of_id: REVERSED_ID })] };
      }
      if (sql.includes("FROM public.of_material_consumptions c") && sql.includes("FOR UPDATE")) {
        return { rows: [] };
      }
      return undefined;
    });
    const result = await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 3,
      correlationId: null,
    });
    expect(result.compensated).toBe(0);
  });

  it("verrouille les consommations d'origine avant de les compenser", async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes("FROM public.stock_movements m")) {
        return { rows: [head({ movement_type: "IN", reversal_of_id: REVERSED_ID })] };
      }
      if (sql.includes("FROM public.of_material_consumptions c")) return { rows: [] };
      return undefined;
    });
    await recordMaterialConsumptionOnPost(client, {
      movementId: MOVEMENT_ID,
      actorUserId: 3,
      correlationId: null,
    });
    const select = calls.find((c) => c.sql.includes("FROM public.of_material_consumptions c"));
    expect(select?.sql).toContain("FOR UPDATE");
  });
});
