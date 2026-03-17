import { createImageUpload } from "../../../middlewares/upload"
import { toStoredImagePath } from "../../../utils/imageStorage"

const OUTILLAGE_ROOT = "outillage"

export const outillageToolUpload = createImageUpload(`${OUTILLAGE_ROOT}/outils`)
export const outillageFabricantUpload = createImageUpload(`${OUTILLAGE_ROOT}/fabricants`)
export const outillageFamilleUpload = createImageUpload(`${OUTILLAGE_ROOT}/familles`)
export const outillageGeometrieUpload = createImageUpload(`${OUTILLAGE_ROOT}/geometries`)

export function getOutillageToolStoredPath(filename: string) {
  return toStoredImagePath(OUTILLAGE_ROOT, "outils", filename)
}

export function getOutillageFabricantStoredPath(filename: string) {
  return toStoredImagePath(OUTILLAGE_ROOT, "fabricants", filename)
}

export function getOutillageFamilleStoredPath(filename: string) {
  return toStoredImagePath(OUTILLAGE_ROOT, "familles", filename)
}

export function getOutillageGeometrieStoredPath(filename: string) {
  return toStoredImagePath(OUTILLAGE_ROOT, "geometries", filename)
}
