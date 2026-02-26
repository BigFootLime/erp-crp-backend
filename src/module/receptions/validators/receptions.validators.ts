import { z } from "zod"

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)")

export const sortDirSchema = z.enum(["asc", "desc"])

export const receptionStatusSchema = z.enum(["OPEN", "CLOSED", "CANCELLED"])
export type ReceptionStatusDTO = z.infer<typeof receptionStatusSchema>

export const lotStatusSchema = z.enum(["LIBERE", "BLOQUE", "EN_ATTENTE", "QUARANTAINE"])
export type LotStatusDTO = z.infer<typeof lotStatusSchema>

export const receptionDocumentTypeSchema = z.enum(["CERTIFICAT_MATIERE", "BON_LIVRAISON", "AUTRE"])
export type ReceptionDocumentTypeDTO = z.infer<typeof receptionDocumentTypeSchema>

export const incomingInspectionStatusSchema = z.enum(["IN_PROGRESS", "DECIDED"])
export type IncomingInspectionStatusDTO = z.infer<typeof incomingInspectionStatusSchema>

export const incomingInspectionDecisionSchema = z.enum(["LIBERE", "BLOQUE"])
export type IncomingInspectionDecisionDTO = z.infer<typeof incomingInspectionDecisionSchema>

export const receptionIdParamSchema = z.object({
  params: z.object({ id: uuid }),
})

export const lineIdParamSchema = z.object({
  params: z.object({ id: uuid, lineId: uuid }),
})

export const docIdParamSchema = z.object({
  params: z.object({ id: uuid, docId: uuid }),
})

export const listReceptionsQuerySchema = z
  .object({
    q: z.string().trim().optional(),
    fournisseur_id: uuid.optional(),
    status: receptionStatusSchema.optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
    sortBy: z.enum(["updated_at", "reception_date", "reception_no", "status"]).optional().default("reception_date"),
    sortDir: sortDirSchema.optional().default("desc"),
  })
  .passthrough()

export type ListReceptionsQueryDTO = z.infer<typeof listReceptionsQuerySchema>

export const createReceptionSchema = z.object({
  body: z
    .object({
      fournisseur_id: uuid,
      reception_date: isoDate.optional().nullable(),
      supplier_reference: z.string().trim().min(1).max(120).optional().nullable(),
      commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    })
    .strict(),
})

export type CreateReceptionBodyDTO = z.infer<typeof createReceptionSchema>["body"]

export const patchReceptionSchema = z.object({
  body: z
    .object({
      status: receptionStatusSchema.optional(),
      reception_date: isoDate.optional(),
      supplier_reference: z.string().trim().min(1).max(120).optional().nullable(),
      commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    })
    .strict(),
})

export type PatchReceptionBodyDTO = z.infer<typeof patchReceptionSchema>["body"]

export const createLineSchema = z.object({
  body: z
    .object({
      article_id: uuid,
      designation: z.string().trim().min(1).max(400).optional().nullable(),
      qty_received: z.coerce.number().positive(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      supplier_lot_code: z.string().trim().min(1).max(120).optional().nullable(),
      notes: z.string().trim().min(1).max(5000).optional().nullable(),
    })
    .strict(),
})

export type CreateLineBodyDTO = z.infer<typeof createLineSchema>["body"]

export const createLotForLineSchema = z.object({
  body: z
    .object({
      lot_code: z.string().trim().min(1).max(80).optional().nullable(),
      supplier_lot_code: z.string().trim().min(1).max(120).optional().nullable(),
      received_at: isoDate.optional().nullable(),
      manufactured_at: isoDate.optional().nullable(),
      expiry_at: isoDate.optional().nullable(),
      notes: z.string().trim().min(1).max(2000).optional().nullable(),
    })
    .strict(),
})

export type CreateLotForLineBodyDTO = z.infer<typeof createLotForLineSchema>["body"]

export const attachDocumentsBodySchema = z
  .object({
    document_type: receptionDocumentTypeSchema,
    reception_line_id: uuid.optional().nullable(),
    commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    label: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .passthrough()

export type AttachDocumentsBodyDTO = z.infer<typeof attachDocumentsBodySchema>

export const addMeasurementSchema = z.object({
  body: z
    .object({
      characteristic: z.string().trim().min(1).max(300),
      nominal_value: z.coerce.number().finite().optional().nullable(),
      tolerance_min: z.coerce.number().finite().optional().nullable(),
      tolerance_max: z.coerce.number().finite().optional().nullable(),
      measured_value: z.coerce.number().finite().optional().nullable(),
      unit: z.string().trim().min(1).max(30).optional().nullable(),
      result: z.enum(["OK", "NOK"]).optional().nullable(),
      comment: z.string().trim().min(1).max(2000).optional().nullable(),
    })
    .strict(),
})

export type AddMeasurementBodyDTO = z.infer<typeof addMeasurementSchema>["body"]

export const decideInspectionSchema = z.object({
  body: z
    .object({
      decision: incomingInspectionDecisionSchema,
      decision_note: z.string().trim().min(1).max(2000).optional().nullable(),
    })
    .strict(),
})

export type DecideInspectionBodyDTO = z.infer<typeof decideInspectionSchema>["body"]

export const stockReceiptSchema = z.object({
  body: z
    .object({
      qty: z.coerce.number().positive(),
      dst_magasin_id: uuid,
      dst_emplacement_id: z.coerce.number().int().positive(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      effective_at: z.string().trim().optional().nullable(),
      notes: z.string().trim().min(1).max(2000).optional().nullable(),
    })
    .strict(),
})

export type StockReceiptBodyDTO = z.infer<typeof stockReceiptSchema>["body"]
