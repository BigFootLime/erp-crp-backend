// src/module/pieces-families/types/pieces-families.types.ts
export type PieceFamily = {
  id: string
  code: string
  designation: string
  type_famille: string | null
  section: string | null
  created_at: string | null
  updated_at: string | null
}

export type CreatePieceFamilyInput = {
  code: string
  designation: string
  type_famille?: string | null
  section?: string | null
}
