import { describe, expect, it, vi } from "vitest";

import { createRecursiveOrdresFabrication } from "./of-generation";

const rootPieceId = "11111111-1111-4111-8111-111111111111";
const childPieceId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const batchId = "44444444-4444-4444-8444-444444444444";
const articleId = "55555555-5555-4555-8555-555555555555";
const rootPath = rootPieceId;
const childPath = `${rootPieceId}/${childPieceId}`;

describe("createRecursiveOrdresFabrication — maturation d'un OF racine", () => {
  it("réutilise le brouillon racine et ne crée qu'un sous-OF pour le manque calculé", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let nextOfId = 100;
    const tx = {
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = String(sql);
        calls.push({ sql: text, params });
        if (text.includes("WITH RECURSIVE tree") && text.includes("pieces_techniques_nomenclature")) {
          return {
            rows: [
              {
                key: rootPath,
                parent_key: null,
                bom_line_id: null,
                parent_piece_technique_id: null,
                piece_technique_id: rootPieceId,
                article_id: articleId,
                code_piece: "ENS-001",
                designation: "Ensemble",
                version_number: 1,
                level: 0,
                ordre_affichage: 0,
                quantite_par_parent: 1,
                quantite_cumulee: 1,
                is_cycle: false,
              },
              {
                key: childPath,
                parent_key: rootPath,
                bom_line_id: "66666666-6666-4666-8666-666666666666",
                parent_piece_technique_id: rootPieceId,
                piece_technique_id: childPieceId,
                article_id: articleId,
                code_piece: "COMP-001",
                designation: "Composant",
                version_number: 1,
                level: 1,
                ordre_affichage: 10,
                quantite_par_parent: 2,
                quantite_cumulee: 2,
                is_cycle: false,
              },
            ],
          };
        }
        if (text.includes("FROM public.piece_technique_versions v") && text.includes("v.statut = 'APPLICABLE'")) {
          return { rows: [{ version_id: versionId, gamme_id: null, version_interne: 1 }] };
        }
        if (text.includes("jsonb_build_object") && text.includes("'piece'")) {
          return { rows: [{ snapshot: { piece: { id: String(params[0]) }, version: { id: versionId }, achats: [] } }] };
        }
        if (text.includes("FROM public.ordres_fabrication") && text.includes("generation_batch_id::text")) {
          return { rows: [{ id: 100, numero: "OF-2026-000100", generation_batch_id: batchId, statut: "BROUILLON", generation_level: 0 }] };
        }
        if (text.toLowerCase().includes("pg_get_serial_sequence")) {
          nextOfId += 1;
          return { rows: [{ of_id: String(nextOfId) }] };
        }
        if (text.includes("public.fn_next_issued_code_value")) return { rows: [{ v: "101" }] };
        if (text.includes("INSERT INTO public.of_operations")) return { rows: [], rowCount: 1 };
        return { rows: [] };
      }),
    };

    const result = await createRecursiveOrdresFabrication(tx as never, {
      source_type: "COMMANDE_CLIENT",
      commande_id: 7,
      commande_numero: "CMD-2026-000007",
      commande_ligne_id: 8,
      livraison_affaire_id: 9,
      client_id: "1",
      root_article_id: articleId,
      root_piece_technique_id: rootPieceId,
      root_pinned_version_id: versionId,
      qty_to_produce: 10,
      user_id: 3,
      existing_root_of_id: 100,
      planned_quantities_by_path: { [rootPath]: 10, [childPath]: 3 },
    });

    expect(result.root_of_id).toBe(100);
    expect(result.ofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 100, parent_of_id: null, structure_path: rootPath }),
      expect.objectContaining({ id: 101, parent_of_id: 100, structure_path: childPath }),
    ]));
    const ofInserts = calls.filter((call) => call.sql.includes("INSERT INTO public.ordres_fabrication"));
    expect(ofInserts).toHaveLength(1);
    expect(ofInserts[0]?.params[0]).toBe(101);
    const rootUpdate = calls.find((call) => call.sql.includes("UPDATE public.ordres_fabrication") && call.sql.includes("completed_from_draft"));
    expect(rootUpdate?.params[0]).toBe(100);
    expect(rootUpdate?.params[14]).toBe(10);
  });
});
