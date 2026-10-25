/**
 * #1762 TEST-only direct-manufacturer bootstrap.
 *
 * Usage (dry run by default):
 *   npx ts-node src/module/outils/scripts/import-direct-suppliers-test.ts --map path/to/map.json --actor-id 12 --actor-username user
 * Add --apply only after the mapping has been reviewed. The map is explicit:
 * {"suppliers":[{"name":"Hoffmann","manufacturers":["HOFFMANN"],"idempotencyKey":"..."}]}
 * Names are not fuzzy-matched and no price, tax basis, unit, date, contact or
 * address is invented. A catalogue item is made only for tools that have both
 * a confirmed manufacturer reference and immutable catalogue provenance.
 */
import { readFile } from "node:fs/promises";
import db from "../../../config/database";
import { createFournisseurSVC, createFournisseurCatalogueItemSVC } from "../../fournisseurs/services/fournisseurs.service";
import { outilRepository } from "../repository/outil.repository";
import { linkToolSupplierOffer } from "../repository/outil-supplier-catalogue.repository";

type Mapping = { suppliers: Array<{ name: string; manufacturers: string[]; idempotencyKey: string }> };
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const apply = process.argv.includes("--apply");

async function main() {
  const file = arg("--map"); const actorId = Number(arg("--actor-id")); const username = arg("--actor-username");
  if (!file || !Number.isInteger(actorId) || actorId <= 0 || !username) throw new Error("--map, --actor-id and --actor-username are required");
  const database = (await db.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database;
  if (database !== "cerp_test") throw new Error("DIRECT_SUPPLIER_IMPORT_TEST_DATABASE_REQUIRED");
  const mapping = JSON.parse(await readFile(file, "utf8")) as Mapping;
  if (!Array.isArray(mapping.suppliers) || mapping.suppliers.length === 0) throw new Error("SUPPLIER_MAP_REQUIRED");
  const audit = { user_id: actorId, ip: null, user_agent: `#1762-direct-supplier-import:${username}`, device_type: null, os: null, browser: null, path: "cli:#1762", page_key: "outillage", client_session_id: null };
  const plan: Array<Record<string, unknown>> = [];
  for (const item of mapping.suppliers) {
    if (!item.name?.trim() || !Array.isArray(item.manufacturers) || !item.idempotencyKey?.trim()) throw new Error("INVALID_SUPPLIER_MAP_ENTRY");
    const manufacturers = await db.query<{ id_fabricant: number; name: string }>("SELECT id_fabricant,name FROM gestion_outils_fabricant WHERE name = ANY($1::text[])", [item.manufacturers]);
    if (manufacturers.rows.length !== item.manufacturers.length) throw new Error(`MANUFACTURER_MAPPING_INCOMPLETE:${item.name}`);
    const eligible = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM gestion_outils_outil o
      JOIN gestion_outils_catalogue_provenance p ON p.id_outil=o.id_outil
      WHERE o.id_fabricant=ANY($1::int[]) AND nullif(btrim(o.reference_fabricant),'') IS NOT NULL`, [manufacturers.rows.map((m) => m.id_fabricant)]);
    plan.push({ supplier: item.name, manufacturers: manufacturers.rows.map((m) => m.name), eligible_tools: eligible.rows[0]?.count ?? 0 });
    if (!apply) continue;
    const supplier = await createFournisseurSVC({ nom: item.name.trim(), actif: true, status: "a_completer", domaines: [{ domaine_code: "outillage", is_primary: true }] }, audit, item.idempotencyKey);
    for (const manufacturer of manufacturers.rows) {
      const current = await db.query<{ fournisseur_id: string }>("SELECT fournisseur_id::text FROM outillage_fabricant_fournisseur_master WHERE id_fabricant=$1", [manufacturer.id_fabricant]);
      await outilRepository.updateFabricant(manufacturer.id_fabricant, manufacturer.name, null, [...new Set([...current.rows.map((r) => r.fournisseur_id), supplier.id])]);
    }
    const tools = await db.query<{ id_outil: number; reference_fabricant: string; designation: string | null; document: string; sha256: string; page: number; rect: number[] }>(`SELECT o.id_outil,o.reference_fabricant,coalesce(nullif(btrim(o.designation_outil_cnc),''),o.reference_fabricant) AS designation,
        p.source_document AS document,p.source_sha256 AS sha256,p.source_page AS page,p.source_rect AS rect
      FROM gestion_outils_outil o JOIN gestion_outils_catalogue_provenance p ON p.id_outil=o.id_outil
      WHERE o.id_fabricant=ANY($1::int[]) AND nullif(btrim(o.reference_fabricant),'') IS NOT NULL`, [manufacturers.rows.map((m) => m.id_fabricant)]);
    for (const tool of tools.rows) {
      const key = `#1762:${supplier.id}:${tool.id_outil}:${tool.reference_fabricant}`;
      const existing = await db.query<{ id: string }>(`SELECT c.id::text AS id FROM fournisseur_catalogue c
        WHERE c.fournisseur_id=$1::uuid AND c.type='OUTILLAGE' AND c.reference_fournisseur=$2 LIMIT 1`, [supplier.id, tool.reference_fabricant]);
      const catalogue = existing.rows[0] ? { id: existing.rows[0].id } : await createFournisseurCatalogueItemSVC(supplier.id, {
        type: "OUTILLAGE", designation: tool.designation ?? tool.reference_fabricant, reference_fournisseur: tool.reference_fabricant,
        actif: true, devise: "EUR", pricing_basis: "NONE", prix_unitaire: null, unite: null, requiert_controle_reception: false,
      }, audit);
      if (!catalogue) throw new Error(`CATALOGUE_CREATION_FAILED:${tool.id_outil}`);
      await linkToolSupplierOffer(tool.id_outil, catalogue.id, { document: tool.document, sha256: tool.sha256, page: tool.page, rect: tool.rect, source_date: null, tax_basis: "UNKNOWN" },
        { userId: actorId, ip: null, userAgent: `#1762:${key}`, path: "cli:#1762", pageKey: "outillage", sessionId: null });
    }
  }
  console.log(JSON.stringify({ apply, database, plan }));
}
main().then(() => db.end()).catch(async (error) => { await db.end(); console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
