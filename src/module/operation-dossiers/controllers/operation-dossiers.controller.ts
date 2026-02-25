import type { Request } from "express"
import type { RequestHandler } from "express"
import fs from "node:fs/promises"
import path from "node:path"

import { HttpError } from "../../../utils/httpError"
import {
  createOperationDossierVersionBodySchema,
  dossierIdParamsSchema,
  documentIdParamsSchema,
  getOperationDossierQuerySchema,
} from "../validators/operation-dossiers.validators"
import {
  computeContentDisposition,
  getDownloadFlag,
  pickMimeType,
  repoFindOperationDossierDocumentFilePath,
  repoGetDocumentName,
  repoGetOperationDossierDocumentFileMeta,
  repoIsOperationDossierDocumentLinked,
} from "../repository/operation-dossiers.repository"
import { svcCreateOperationDossierVersion, svcGetOperationDossierByOperation } from "../services/operation-dossiers.service"
import type { AuditContext } from "../repository/operation-dossiers.repository"

function buildAuditContext(req: Request): AuditContext {
  const user = req.user
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")

  const forwardedFor = req.headers["x-forwarded-for"]
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  }
}

function getMulterFiles(req: Request): Express.Multer.File[] {
  const filesValue = (req as unknown as { files?: unknown }).files
  const files = Array.isArray(filesValue) ? (filesValue as Express.Multer.File[]) : []
  return files.filter((f) => f && typeof f === "object" && typeof (f as Express.Multer.File).path === "string")
}

export const getOperationDossierByOperation: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const query = getOperationDossierQuerySchema.parse(req.query)
    const out = await svcGetOperationDossierByOperation({ query, audit })
    res.json(out)
  } catch (e) {
    next(e)
  }
}

export const createOperationDossierVersion: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req)
    const { dossierId } = dossierIdParamsSchema.parse(req.params)
    const body = createOperationDossierVersionBodySchema.parse(req.body)
    const files = getMulterFiles(req)

    for (const f of files) {
      if (!/^documents\[DOC_\d{2}\]$/.test(f.fieldname)) {
        await fs.unlink(f.path).catch(() => undefined)
        throw new HttpError(400, "INVALID_FILE_FIELD", `Invalid file field: ${f.fieldname}`)
      }
    }

    const out = await svcCreateOperationDossierVersion({ dossier_id: dossierId, body, files, audit })
    res.status(201).json(out)
  } catch (e) {
    next(e)
  }
}

export const downloadOperationDossierDocument: RequestHandler = async (req, res, next) => {
  try {
    buildAuditContext(req)
    const { documentId } = documentIdParamsSchema.parse(req.params)
    const linked = await repoIsOperationDossierDocumentLinked(documentId)
    if (!linked) {
      res.status(404).json({ error: "Not found" })
      return
    }

    const meta = await repoGetOperationDossierDocumentFileMeta(documentId)
    const name = meta?.file_name ?? (await repoGetDocumentName(documentId)) ?? `document-${documentId}`
    const filePath = await repoFindOperationDossierDocumentFilePath({ documentId, fileNameHint: meta?.file_name ?? null })
    if (!filePath) {
      res.status(404).json({ error: "File not found" })
      return
    }

    await fs.access(filePath)
    const download = getDownloadFlag((req.query as { download?: unknown } | undefined)?.download)
    res.setHeader("Content-Type", pickMimeType(meta?.mime_type ?? null))
    res.setHeader("Content-Disposition", computeContentDisposition({ download, filename: name }))
    res.sendFile(path.resolve(filePath))
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"))
      return
    }
    next(err)
  }
}
