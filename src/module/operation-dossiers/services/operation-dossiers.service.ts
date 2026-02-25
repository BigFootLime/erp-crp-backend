import { HttpError } from "../../../utils/httpError"
import type { CreateOperationDossierVersionBodyDTO, GetOperationDossierQueryDTO } from "../validators/operation-dossiers.validators"
import type {
  CreateOperationDossierVersionResult,
  OperationDossierOperationResponse,
} from "../types/operation-dossiers.types"
import type { AuditContext } from "../repository/operation-dossiers.repository"
import {
  buildOperationDossierOperationResponse,
  parseSlotOverrideMap,
  parseUploadsBySlot,
  repoCreateOperationDossierVersion,
  repoGetOperationDossierTimeline,
  repoUpsertOperationDossier,
  validateSlotKeysForDossierType,
} from "../repository/operation-dossiers.repository"

export async function svcGetOperationDossierByOperation(params: { query: GetOperationDossierQueryDTO; audit: AuditContext }): Promise<OperationDossierOperationResponse> {
  const dossier = await repoUpsertOperationDossier({
    operation_type: params.query.operation_type,
    operation_id: params.query.operation_id,
    dossier_type: params.query.dossier_type,
    audit: params.audit,
  })

  const timeline = await repoGetOperationDossierTimeline(dossier.id)
  return buildOperationDossierOperationResponse(timeline)
}

export async function svcCreateOperationDossierVersion(params: {
  dossier_id: string
  body: CreateOperationDossierVersionBodyDTO
  files: Express.Multer.File[]
  audit: AuditContext
}): Promise<CreateOperationDossierVersionResult> {
  const rawBody = params.body as unknown as Record<string, unknown>
  const uploadsBySlot = parseUploadsBySlot(params.files)

  const labelBySlot = parseSlotOverrideMap({ body: rawBody, prefix: "label" })
  const docCommentBySlot = parseSlotOverrideMap({ body: rawBody, prefix: "docComment" })

  // Validate slot keys against dossier type (read from DB inside tx)
  // We validate upload/override slot keys early only for format; allowed list is checked later once dossier_type is known.
  for (const slotKey of [...uploadsBySlot.keys(), ...labelBySlot.keys(), ...docCommentBySlot.keys()]) {
    if (!/^DOC_\d{2}$/.test(slotKey)) {
      throw new HttpError(400, "INVALID_SLOT_KEY", `Invalid slot key format: ${slotKey}`)
    }
  }

  const commentaire = params.body.commentaire?.trim() ? params.body.commentaire.trim() : null

  // Create version (repo enforces allowed slots based on dossier_type)
  // We still validate that request only references allowed slot keys after we know dossier_type.
  const dossierHeader = await repoGetOperationDossierTimeline(params.dossier_id).then((t) => t.dossier)
  validateSlotKeysForDossierType({ dossier_type: dossierHeader.dossier_type, slotKeys: uploadsBySlot.keys() })
  validateSlotKeysForDossierType({ dossier_type: dossierHeader.dossier_type, slotKeys: labelBySlot.keys() })
  validateSlotKeysForDossierType({ dossier_type: dossierHeader.dossier_type, slotKeys: docCommentBySlot.keys() })

  return repoCreateOperationDossierVersion({
    dossier_id: params.dossier_id,
    commentaire,
    uploadsBySlot,
    labelBySlot,
    docCommentBySlot,
    audit: params.audit,
  })
}
