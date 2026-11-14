import { buildOldMaterialDefinition, type OldMaterialDefinitionSource } from "../domain/old-material-definition";

export type OldMaterialDefinitionProjection = {
  material_article_category: string | null;
  material_designation: string;
  material_profile_code: string | null;
  material_nuance_code: string | null;
  material_etat_code: string | null;
  material_sous_etat_code: string | null;
  material_longueur_mm: number | null;
  material_largeur_mm: number | null;
  material_hauteur_mm: number | null;
  material_epaisseur_mm: number | null;
  material_diametre_mm: number | null;
};

function oldMaterialDefinitionFromProjection(row: OldMaterialDefinitionProjection): string | null {
  const source: OldMaterialDefinitionSource = {
    article_category: row.material_article_category,
    designation: row.material_designation,
    profile_code: row.material_profile_code,
    nuance_code: row.material_nuance_code,
    etat_code: row.material_etat_code,
    sous_etat_code: row.material_sous_etat_code,
    longueur_mm: row.material_longueur_mm,
    largeur_mm: row.material_largeur_mm,
    hauteur_mm: row.material_hauteur_mm,
    epaisseur_mm: row.material_epaisseur_mm,
    diametre_mm: row.material_diametre_mm,
  };
  return buildOldMaterialDefinition(source);
}
