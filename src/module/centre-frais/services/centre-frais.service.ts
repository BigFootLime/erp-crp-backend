// src/module/pieces-families/services/pieces-families.service.ts
import type { PieceCF, CreatePieceCFInput } from "../types/centre-frais.types"
import {
  repoCreatePieceCF,
  repoDeletePieceCF,
  repoGetPieceCF,
  repoListPieceCF,
  repoUpdatePieceCF,
} from "../repository/centre-frais.repository"

export async function createPieceCFSVC(
  input: CreatePieceCFInput
): Promise<PieceCF> {
  try {
    return await repoCreatePieceCF(input)
  } catch (err: any) {
    if (err?.code === "23505") {
      if (String(err.detail || "").includes("code")) {
        throw new Error("Code de CF déjà utilisé")
      }
      throw new Error("Conflit de contrainte")
    }
    throw err
  }
}

export const listPieceCFSVC = () => repoListPieceCF()
export const getPieceCFSVC = (id: string) => repoGetPieceCF(id)
export const deletePieceCFSVC = (id: string) => repoDeletePieceCF(id)

export async function updatePieceCFSVC(
  id: string,
  patch: Partial<CreatePieceCFInput>
) {
  return repoUpdatePieceCF(id, patch)
}
