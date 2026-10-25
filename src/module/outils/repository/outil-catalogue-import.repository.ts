import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";

type DbClient = Pick<PoolClient, "query">;

export type CatalogueTaxonomy = Readonly<{ manufacturerId: number; familyId: number; geometryId: number | null; revetementId: number | null }>;

const lock = (client: DbClient, key: string) => client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);

export const outilCatalogueImportRepository = {
  async assertTestDatabase(client: DbClient): Promise<void> {
    const result = await client.query("SELECT current_database() AS database");
    if (result.rows[0]?.database !== "cerp_test") {
      throw new HttpError(403, "CATALOGUE_IMPORT_TEST_DATABASE_REQUIRED", "Lâ€™import catalogue est rÃ©servÃ© Ã  cerp_test.");
    }
  },

  async assertImportSchema(client: DbClient): Promise<void> {
    const result = await client.query(`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'gestion_outils_catalogue_provenance'
        AND column_name = 'source_specifications'
    ) AS available`);
    if (result.rows[0]?.available !== true) {
      throw new HttpError(503, "CATALOGUE_IMPORT_SCHEMA_UNAVAILABLE", "Le patch cerp_test de spécifications catalogue n’est pas appliqué.");
    }
  },


  async resolveTaxonomy(client: DbClient, manufacturer: string, family: string, geometry: string | null, coating: string | null): Promise<CatalogueTaxonomy> {
    await lock(client, `catalogue-taxonomy:${manufacturer}:${family}:${geometry ?? ""}:${coating ?? ""}`);
    const manufacturerRow = await client.query<{ id_fabricant: number }>(
      "SELECT id_fabricant FROM gestion_outils_fabricant WHERE lower(btrim(name)) = lower(btrim($1)) LIMIT 1",
      [manufacturer]
    );
    const manufacturerId = manufacturerRow.rows[0]?.id_fabricant
      ?? (await client.query<{ id_fabricant: number }>("INSERT INTO gestion_outils_fabricant(name, logo) VALUES($1, NULL) RETURNING id_fabricant", [manufacturer])).rows[0]?.id_fabricant;
    if (!manufacturerId) throw new HttpError(503, "CATALOGUE_IMPORT_REFERENCE_UNAVAILABLE", "Fabricant non disponible.");

    const familyRow = await client.query<{ id_famille: number }>(
      "SELECT id_famille FROM gestion_outils_famille WHERE lower(btrim(nom_famille)) = lower(btrim($1)) LIMIT 1",
      [family]
    );
    const familyId = familyRow.rows[0]?.id_famille
      ?? (await client.query<{ id_famille: number }>("INSERT INTO gestion_outils_famille(nom_famille, image_path) VALUES($1, NULL) RETURNING id_famille", [family])).rows[0]?.id_famille;
    if (!familyId) throw new HttpError(503, "CATALOGUE_IMPORT_REFERENCE_UNAVAILABLE", "Famille non disponible.");

    let revetementId: number | null = null;
    if (coating) {
      const coatingRow = await client.query<{ id_revetement: number }>("SELECT id_revetement FROM gestion_outils_revetement WHERE id_fabricant = $1 AND lower(btrim(nom)) = lower(btrim($2)) LIMIT 1", [manufacturerId, coating]);
      revetementId = coatingRow.rows[0]?.id_revetement
        ?? (await client.query<{ id_revetement: number }>("INSERT INTO gestion_outils_revetement(nom, id_fabricant) VALUES($1, $2) RETURNING id_revetement", [coating, manufacturerId])).rows[0]?.id_revetement
        ?? null;
    }
    if (!geometry) return { manufacturerId, familyId, geometryId: null, revetementId };
    const geometryRow = await client.query<{ id_geometrie: number }>(
      "SELECT id_geometrie FROM gestion_outils_geometrie WHERE id_famille = $1 AND lower(btrim(nom_geometrie)) = lower(btrim($2)) LIMIT 1",
      [familyId, geometry]
    );
    const geometryId = geometryRow.rows[0]?.id_geometrie
      ?? (await client.query<{ id_geometrie: number }>("INSERT INTO gestion_outils_geometrie(nom_geometrie, id_famille, image_path) VALUES($1, $2, NULL) RETURNING id_geometrie", [geometry, familyId])).rows[0]?.id_geometrie;
    if (!geometryId) throw new HttpError(503, "CATALOGUE_IMPORT_REFERENCE_UNAVAILABLE", "GÃ©omÃ©trie non disponible.");
    return { manufacturerId, familyId, geometryId, revetementId };
  },

  async findExisting(client: DbClient, manufacturerId: number, reference: string, selectionId: string): Promise<number | null> {
    const result = await client.query<{ id_outil: number }>(
      `SELECT o.id_outil
       FROM gestion_outils_outil o
       LEFT JOIN gestion_outils_catalogue_provenance cp ON cp.id_outil = o.id_outil
       WHERE o.id_fabricant = $1 AND lower(btrim(o.reference_fabricant)) = lower(btrim($2))
         AND cp.source_selection_id = $3
       LIMIT 1`,
      [manufacturerId, reference, selectionId]
    );
    return result.rows[0]?.id_outil ?? null;
  },

  async advisoryImportLock(client: DbClient, manufacturer: string, reference: string, selectionId: string): Promise<void> {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`catalogue-import:${manufacturer}:${reference}:${selectionId}`]);
  },
};
