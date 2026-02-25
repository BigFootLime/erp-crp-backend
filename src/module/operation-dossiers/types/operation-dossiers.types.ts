export type OperationDossierOperationType = "PIECE_TECHNIQUE_OPERATION" | "OF_OPERATION"

export type OperationDossierType = "TECHNIQUE" | "PROGRAMMATION"

export type UserLite = {
  id: number
  username: string
  name: string | null
  surname: string | null
  label: string
}

export type OperationDossierHeader = {
  id: string
  operation_type: OperationDossierOperationType
  operation_id: string
  dossier_type: OperationDossierType
  title: string | null
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type OperationDossierVersionDocument = {
  id: string
  dossier_version_id: string
  slot_key: string
  label: string | null
  commentaire: string | null
  document_id: string | null
  mime_type: string | null
  file_name: string | null
  file_size_bytes: number | null
  created_at: string
  updated_at: string
}

export type OperationDossierVersion = {
  id: string
  dossier_id: string
  version: number
  commentaire: string | null
  created_at: string
  created_by: UserLite | null
  documents: OperationDossierVersionDocument[]
}

export type OperationDossierOperationResponse = {
  dossier: OperationDossierHeader
  versions: OperationDossierVersion[]
  latest: OperationDossierVersion | null
}

export type CreateOperationDossierVersionResult = {
  id: string
  dossier_id: string
  version: number
}
