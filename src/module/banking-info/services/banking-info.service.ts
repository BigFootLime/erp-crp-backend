// src/module/banking-info/services/banking-info.service.ts
import type { CreateBankingInfoInput, BankingInfo } from "../types/banking-info.types"
import {
  repoCreateBankingInfo,
  repoDeleteBankingInfo,
  repoGetBankingInfo,
  repoListBankingInfos,
  repoUpdateBankingInfo,
} from "../repository/banking-info.repository"

function normalizeIban(iban: string) {
  return iban.replace(/\s+/g, "").toUpperCase()
}
function normalizeBic(bic: string) {
  return bic.replace(/\s+/g, "").toUpperCase()
}

export async function createBankingInfoSVC(input: CreateBankingInfoInput): Promise<BankingInfo> {
  try {
    return await repoCreateBankingInfo({
      ...input,
      iban: normalizeIban(input.iban),
      bic: normalizeBic(input.bic),
    })
  } catch (err: any) {
    // Handle unique violations (PG code 23505)
    if (err?.code === "23505") {
      // constraint names in your schema: informations_bancaires_iban_key / _bic_key
      if (String(err.detail || "").includes("iban")) throw new Error("IBAN déjà utilisé")
      if (String(err.detail || "").includes("bic")) throw new Error("BIC déjà utilisé")
      throw new Error("Conflit de contrainte")
    }
    throw err
  }
}

export const listBankingInfosSVC = () => repoListBankingInfos()
export const getBankingInfoSVC = (id: string) => repoGetBankingInfo(id)
export const deleteBankingInfoSVC = (id: string) => repoDeleteBankingInfo(id)

export async function updateBankingInfoSVC(id: string, patch: Partial<CreateBankingInfoInput>) {
  if (patch.iban) patch.iban = normalizeIban(patch.iban)
  if (patch.bic) patch.bic = normalizeBic(patch.bic)
  return repoUpdateBankingInfo(id, patch)
}
