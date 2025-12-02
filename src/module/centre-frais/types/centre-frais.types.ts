// src/module/pieces-families/types/pieces-families.types.ts
export type PieceCF = {
  id: string
  code: string
  designation: string
  type_cf: string | null
  section: string | null
  created_at: string | null
  updated_at: string | null
}

export type CreatePieceCFInput = {
  code: string
  designation: string
  type_cf?: string | null
  section?: string | null
}
