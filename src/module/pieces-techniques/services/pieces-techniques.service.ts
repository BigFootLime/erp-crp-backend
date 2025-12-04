// src/module/pieces-techniques/services/pieces-techniques.service.ts
import type { CreatePieceTechniqueInput, PieceTechnique } from "../types/pieces-techniques.types"
import {
  repoCreatePieceTechnique,
  repoDeletePieceTechnique,
  repoGetPieceTechnique,
  repoListPieceTechniques,
  repoUpdatePieceTechnique,
} from "../repository/pieces-techniques.repository"

export async function createPieceTechniqueSVC(
  input: CreatePieceTechniqueInput
): Promise<PieceTechnique> {
  try {
    return await repoCreatePieceTechnique(input)
  } catch (err: any) {
    if (err?.code === "23505") {
      if (String(err.detail || "").includes("code_piece")) {
        throw new Error("Code de pièce déjà utilisé")
      }
      throw new Error("Conflit de contrainte")
    }
    throw err
  }
}

export const listPieceTechniquesSVC = () => repoListPieceTechniques()
export const getPieceTechniqueSVC = (id: string) => repoGetPieceTechnique(id)
export const deletePieceTechniqueSVC = (id: string) => repoDeletePieceTechnique(id)

export async function updatePieceTechniqueSVC(
  id: string,
  patch: CreatePieceTechniqueInput
): Promise<PieceTechnique | null> {
  return repoUpdatePieceTechnique(id, patch)
}
