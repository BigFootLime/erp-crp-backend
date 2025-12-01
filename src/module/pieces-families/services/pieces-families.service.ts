// src/module/pieces-families/services/pieces-families.service.ts
import type { PieceFamily, CreatePieceFamilyInput } from "../types/pieces-families.types"
import {
  repoCreatePieceFamily,
  repoDeletePieceFamily,
  repoGetPieceFamily,
  repoListPieceFamilies,
  repoUpdatePieceFamily,
} from "../repository/pieces-families.repository"

export async function createPieceFamilySVC(
  input: CreatePieceFamilyInput
): Promise<PieceFamily> {
  try {
    return await repoCreatePieceFamily(input)
  } catch (err: any) {
    if (err?.code === "23505") {
      if (String(err.detail || "").includes("code")) {
        throw new Error("Code de famille déjà utilisé")
      }
      throw new Error("Conflit de contrainte")
    }
    throw err
  }
}

export const listPieceFamiliesSVC = () => repoListPieceFamilies()
export const getPieceFamilySVC = (id: string) => repoGetPieceFamily(id)
export const deletePieceFamilySVC = (id: string) => repoDeletePieceFamily(id)

export async function updatePieceFamilySVC(
  id: string,
  patch: Partial<CreatePieceFamilyInput>
) {
  return repoUpdatePieceFamily(id, patch)
}
