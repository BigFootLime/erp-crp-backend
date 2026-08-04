import { createImageUpload } from "../../../middlewares/upload"
import { promoteSecureUpload } from "../../../shared/uploads/secure-upload"
import { ensureImagesSubdir, toStoredImagePath } from "../../../utils/imageStorage"

const OUTILLAGE_ROOT = "outillage"

export const outillageToolUpload = createImageUpload(`${OUTILLAGE_ROOT}/outils`, "tool-media")
export const outillageFabricantUpload = createImageUpload(`${OUTILLAGE_ROOT}/fabricants`)
export const outillageFamilleUpload = createImageUpload(`${OUTILLAGE_ROOT}/familles`)
export const outillageGeometrieUpload = createImageUpload(`${OUTILLAGE_ROOT}/geometries`)

export type OutillageToolUploadFiles = Readonly<{
  esquisse?: Express.Multer.File
  plan?: Express.Multer.File
  image?: Express.Multer.File
}>

export type PromotedOutillageFile = Readonly<{
  file: Express.Multer.File
  absolutePath: string
  storedPath: string
}>

async function promoteOutillageFile(
  file: Express.Multer.File,
  subdirectory: "outils" | "fabricants" | "familles" | "geometries"
): Promise<PromotedOutillageFile> {
  const absolutePath = await promoteSecureUpload(file, ensureImagesSubdir(OUTILLAGE_ROOT, subdirectory))
  return {
    file,
    absolutePath,
    storedPath: toStoredImagePath(OUTILLAGE_ROOT, subdirectory, file.filename),
  }
}

export async function promoteOutillageToolFiles(files: OutillageToolUploadFiles) {
  const promoted: Partial<Record<keyof OutillageToolUploadFiles, PromotedOutillageFile>> = {}
  for (const field of ["esquisse", "plan", "image"] as const) {
    const file = files[field]
    if (file) promoted[field] = await promoteOutillageFile(file, "outils")
  }
  return promoted
}

export function promoteOutillageFabricantFile(file: Express.Multer.File) {
  return promoteOutillageFile(file, "fabricants")
}

export function promoteOutillageFamilleFile(file: Express.Multer.File) {
  return promoteOutillageFile(file, "familles")
}

export function promoteOutillageGeometrieFile(file: Express.Multer.File) {
  return promoteOutillageFile(file, "geometries")
}

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
