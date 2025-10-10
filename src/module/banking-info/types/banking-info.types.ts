// src/module/banking-info/types/banking-info.types.ts
export type BankingInfo = {
  bank_info_id: string
  name: string
  iban: string
  bic: string
  creation_date: string | null
  created_by: string | null
  modification_date: string | null
  modified_by: string | null
}

export type CreateBankingInfoInput = {
  name: string
  iban: string
  bic: string
  creation_date?: string
}
