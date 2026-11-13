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
      const global = await client.query<{ id_revetement: number; id_fabricant: number }>(
        "SELECT id_revetement, id_fabricant FROM gestion_outils_revetement WHERE lower(btrim(nom)) = lower(btrim($1)) LIMIT 1",
        [coating]
      );
      if (global.rows[0]?.id_fabricant === manufacturerId) {
        revetementId = global.rows[0].id_revetement;
      } else {
        const label = global.rows[0] ? `${coating} (${manufacturer})` : coating;
        const qualified = await client.query<{ id_revetement: number; id_fabricant: number }>(
          "SELECT id_revetement, id_fabricant FROM gestion_outils_revetement WHERE lower(btrim(nom)) = lower(btrim($1)) LIMIT 1",
          [label]
        );
        if (qualified.rows[0] && qualified.rows[0].id_fabricant !== manufacturerId) {
          throw new HttpError(409, "CATALOGUE_IMPORT_TAXONOMY_CONFLICT", `Qualified coating unavailable: ${label}`);
        }
        revetementId = qualified.rows[0]?.id_revetement
          ?? (await client.query<{ id_revetement: number }>("INSERT INTO gestion_outils_revetement(nom, id_fabricant) VALUES($1, $2) RETURNING id_revetement", [label, manufacturerId])).rows[0]?.id_revetement
          ?? null;
      }
    }
    if (!geometry) return { manufacturerId, familyId, geometryId: null, revetementId };
    const globalGeometry = await client.query<{ id_geometrie: number; id_famille: number }>(
      "SELECT id_geometrie, id_famille FROM gestion_outils_geometrie WHERE lower(btrim(nom_geometrie)) = lower(btrim($1)) LIMIT 1",
      [geometry]
    );
    if (globalGeometry.rows[0]?.id_famille === familyId) {
      return { manufacturerId, familyId, geometryId: globalGeometry.rows[0].id_geometrie, revetementId };
    }
    const label = globalGeometry.rows[0] ? `${geometry} (${family})` : geometry;
    const qualifiedGeometry = await client.query<{ id_geometrie: number; id_famille: number }>(
      "SELECT id_geometrie, id_famille FROM gestion_outils_geometrie WHERE lower(btrim(nom_geometrie)) = lower(btrim($1)) LIMIT 1",
      [label]
    );
    if (qualifiedGeometry.rows[0] && qualifiedGeometry.rows[0].id_famille !== familyId) {
      throw new HttpError(409, "CATALOGUE_IMPORT_TAXONOMY_CONFLICT", `Qualified geometry unavailable: ${label}`);
    }
    const geometryId = qualifiedGeometry.rows[0]?.id_geometrie
      ?? (await client.query<{ id_geometrie: number }>("INSERT INTO gestion_outils_geometrie(nom_geometrie, id_famille, image_path) VALUES($1, $2, NULL) RETURNING id_geometrie", [label, familyId])).rows[0]?.id_geometrie;
    if (!geometryId) throw new HttpError(503, "CATALOGUE_IMPORT_REFERENCE_UNAVAILABLE", "Geometry unavailable.");
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
