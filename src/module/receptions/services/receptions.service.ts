import type {
  AddMeasurementBodyDTO,
  AttachDocumentsBodyDTO,
  CreateLineBodyDTO,
  CreateLotForLineBodyDTO,
  CreateReceptionBodyDTO,
  DecideInspectionBodyDTO,
  ListReceptionsQueryDTO,
  PatchReceptionBodyDTO,
  StockReceiptBodyDTO,
} from "../validators/receptions.validators"
import type { AuditContext } from "../repository/receptions.repository"
import * as repo from "../repository/receptions.repository"

type UploadedDocument = Express.Multer.File

export const listReceptionsSVC = (filters: ListReceptionsQueryDTO) => repo.repoListReceptions(filters)

export const getReceptionsKpisSVC = () => repo.repoGetReceptionsKpis()

export const getReceptionSVC = (id: string) => repo.repoGetReception(id)

export const createReceptionSVC = (body: CreateReceptionBodyDTO, audit: AuditContext) => repo.repoCreateReception(body, audit)

export const patchReceptionSVC = (id: string, patch: PatchReceptionBodyDTO, audit: AuditContext) => repo.repoPatchReception(id, patch, audit)

export const createReceptionLineSVC = (receptionId: string, body: CreateLineBodyDTO, audit: AuditContext) =>
  repo.repoCreateLine(receptionId, body, audit)

export const createLotForLineSVC = (receptionId: string, lineId: string, body: CreateLotForLineBodyDTO, audit: AuditContext) =>
  repo.repoCreateLotForLine(receptionId, lineId, body, audit)

export const attachReceptionDocumentsSVC = (receptionId: string, body: AttachDocumentsBodyDTO, docs: UploadedDocument[], audit: AuditContext) =>
  repo.repoAttachDocuments(receptionId, body, docs, audit)

export const removeReceptionDocumentSVC = (receptionId: string, docId: string, audit: AuditContext) =>
  repo.repoRemoveDocument(receptionId, docId, audit)

export const downloadReceptionDocumentSVC = (receptionId: string, docId: string, audit: AuditContext) =>
  repo.repoGetDocumentForDownload(receptionId, docId, audit)

export const startIncomingInspectionSVC = (receptionId: string, lineId: string, audit: AuditContext) =>
  repo.repoStartInspection(receptionId, lineId, audit)

export const addIncomingMeasurementSVC = (receptionId: string, lineId: string, body: AddMeasurementBodyDTO, audit: AuditContext) =>
  repo.repoAddMeasurement(receptionId, lineId, body, audit)

export const decideIncomingInspectionSVC = (receptionId: string, lineId: string, body: DecideInspectionBodyDTO, audit: AuditContext) =>
  repo.repoDecideInspection(receptionId, lineId, body, audit)

export const createReceptionStockReceiptSVC = (receptionId: string, lineId: string, body: StockReceiptBodyDTO, audit: AuditContext) =>
  repo.repoCreateStockReceipt(receptionId, lineId, body, audit)
