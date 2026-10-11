import { describe, expect, it, vi } from "vitest";
import { createPreparationDraftTree } from "./preparation-generation";
import { createIncompleteDraftOrdreFabrication } from "./of-generation";
import { PREPARATION_RULES_VERSION } from "./preparation-rules";

const rootPiece = "11111111-1111-4111-8111-111111111111";
const childPiece = "22222222-2222-4222-8222-222222222222";
const rootVersion = "33333333-3333-4333-8333-333333333333";
const childVersion = "44444444-4444-4444-8444-444444444444";
const article = "55555555-5555-4555-8555-555555555555";
const lineId = "66666666-6666-4666-8666-666666666666";
const input = { commande_id: 12, commande_numero: "CMD-TEST", commande_ligne_id: 18,
  livraison_affaire_id: 23, client_id: "7", root_article_id: article,
  root_piece_technique_id: rootPiece, root_pinned_version_id: rootVersion,
  qty_to_produce: 4, user_id: 9, idempotency_key: "recipe-generation", request_hash: "same-command" };

function transaction() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const orders = new Map<number, Record<string, unknown>>();
  let next = 100, replay: unknown = null;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT request_hash,result")) return { rows: replay ? [{ request_hash: input.request_hash, result: replay }] : [] };
    if (sql.includes("AS enabled")) return { rows: [{ enabled: true }] };
    if (sql.includes("pg_get_serial_sequence")) return { rows: [{ id: ++next, of_id: next }] };
    if (sql.includes("fn_next_issued_code_value")) return { rows: [{ v: String(next) }] };
    if (sql.includes("SELECT p.article_id::text")) return { rows: [{ article_id: article, version_id: params[0] === rootPiece ? rootVersion : childVersion }] };
    if (sql.includes("INSERT INTO public.ordres_fabrication")) {
      const child = sql.includes("source_bom_line_id");
      const incomplete = sql.includes("'NORMAL'::of_priority");
      const id = Number(params[0]);
      orders.set(id, { id, piece_technique_id: child ? childPiece : rootPiece,
        version_id: incomplete ? null : child ? childVersion : rootVersion,
        client_id: "7", commande_id: 12, commande_ligne_id: 18, affaire_id: 23,
        root_of_id: child ? params[9] : id, generation_level: child ? 1 : 0,
        quantity_cumulative: child ? params[17] : 1, quantite_lancee: child ? params[14] : 4,
        statut: "BROUILLON", technical_snapshot_sha256: null });
    }
    if (sql.includes("SELECT id::bigint::int,piece_technique_id::text")) return { rows: [orders.get(Number(params[0]))] };
    if (sql.includes("SELECT assembly_supply_strategy")) return { rows: [{ assembly_supply_strategy: "MAKE_TO_ORDER" }] };
    if (sql.includes("SELECT id::text,child_piece_technique_id::text")) return { rows: params[0] === rootVersion
      ? [{ id: lineId, child_piece_technique_id: childPiece, child_piece_technique_version_id: childVersion, child_article_id: article, quantite: 2, rang: 10 }] : [] };
    if (sql.includes("AS quantity FROM public.of_component_requirements")) return { rows: [{ quantity: 0 }] };
    if (sql.includes("INSERT INTO public.of_component_requirements")) return { rows: [{ id: lineId }] };
    if (sql.includes("0 AS operations_count,technical_readiness,structure_path")) return { rows: [...orders.values()].map(o => ({
      id: o.id, root_of_id: o.root_of_id, parent_of_id: o.generation_level ? 101 : null,
      generation_level: o.generation_level, commande_ligne_id: 18, operations_count: 0, technical_readiness: "INCOMPLETE" })) };
    if (sql.includes("SET root_of_id=$2,result=$3::jsonb")) replay = JSON.parse(String(params[2]));
    return { rows: [], rowCount: 1 };
  });
  return { query, calls, orders };
}

describe("current preparation policy on draft generation", () => {
  it("creates the root and required child quantities with the current policy, no invented operations or frozen proof", async () => {
    const tx = transaction();
    const result = await createPreparationDraftTree(tx as never, input);
    expect(result.root_of_id).toBe(101);
    expect(result.ofs.map(o => o.id)).toEqual([101, 102]);
    const batch = tx.calls.find(c => c.sql.includes("INSERT INTO public.of_generation_batches"))!;
    expect(batch.sql).toContain("'preparation_rules_version',$12::int");
    expect(batch.params[11]).toBe(PREPARATION_RULES_VERSION);
    const inserts = tx.calls.filter(c => c.sql.includes("INSERT INTO public.ordres_fabrication"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params.slice(10)).toEqual([4, rootVersion, 9, PREPARATION_RULES_VERSION]);
    expect(inserts[0].sql).toContain("$14,$13,$13");
    expect(inserts[1].params.slice(14)).toEqual([8, childVersion, 9, 2, PREPARATION_RULES_VERSION]);
    expect(inserts[1].sql).toContain("$19,$17,$17");
    expect(tx.calls.some(c => /INSERT INTO public\.of_operations|SET technical_snapshot/.test(c.sql))).toBe(false);
    expect([...tx.orders.values()].every(o => o.statut === "BROUILLON" && o.technical_snapshot_sha256 === null)).toBe(true);
  });
  it("returns the original batch on a retry without creating or reinterpreting its historical evidence", async () => {
    const tx = transaction();
    const first = await createPreparationDraftTree(tx as never, input);
    const before = tx.calls.length;
    const retry = await createPreparationDraftTree(tx as never, input);
    expect(retry).toMatchObject(first);
    expect(tx.calls.slice(before).map(c => c.sql)).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "SELECT request_hash,result FROM public.of_generation_batches WHERE idempotency_key=$1",
    ]);
    expect(tx.orders.size).toBe(2);
  });
  it("rejects a changed request on the same key without writing another OF", async () => {
    const tx = transaction();
    await createPreparationDraftTree(tx as never, input);
    const before = tx.calls.length;
    await expect(createPreparationDraftTree(tx as never, { ...input, request_hash: "changed-command", qty_to_produce: 5 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(tx.calls.slice(before).some(c => /INSERT|UPDATE/.test(c.sql))).toBe(false);
  });
  it("uses current rules for an incomplete customer-order placeholder while preserving the missing technical revision", async () => {
    const tx = transaction();
    const result = await createIncompleteDraftOrdreFabrication(tx as never, {
      commande_id: 12, commande_numero: "CMD-TEST", commande_ligne_id: 18,
      livraison_affaire_id: 23, client_id: "7", article_id: article,
      piece_technique_id: rootPiece, qty_to_produce: 4, user_id: 9,
    });
    expect(result.id).toBe(101);
    const policy = tx.calls.find(c => c.sql.includes("SET preparation_rules_version="))!;
    expect(policy.params).toEqual([101, PREPARATION_RULES_VERSION]);
    const batch = tx.calls.find(c => c.sql.includes("INSERT INTO public.of_generation_batches"))!;
    expect(JSON.parse(String(batch.params[6]))).toMatchObject({ preparation_rules_version: PREPARATION_RULES_VERSION, technical_readiness: "INCOMPLETE" });
    expect(tx.orders.get(101)?.version_id).toBe(null);
    expect(tx.calls.some(c => c.sql.includes("INSERT INTO public.of_operations"))).toBe(false);
  });
});
