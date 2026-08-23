import type { Request, RequestHandler, Response } from "express";

import db from "../../config/database";
import { asyncHandler } from "../../utils/asyncHandler";
import { HttpError } from "../../utils/httpError";
import { setSecureDownloadHeaders } from "../uploads/secure-download";
import { assertAuthoritativePdfFilename } from "./authoritative-document.filename";
import {
  getOfficialDocumentGenerationEnvelope,
  readOfficialPdfBytes,
  recordOfficialPdfPrintIntent,
} from "./authoritative-document.service";

/**
 * The factory is deliberately an internal adapter, not a catch-all HTTP route.
 * Each aggregate wires a fixed kind and its own existing read/export middleware.
 */
export const CREATION_SNAPSHOT_DOCUMENT_KINDS = [
  "CLIENT_CREATION_SNAPSHOT",
  "SUPPLIER_CREATION_SNAPSHOT",
  "CUSTOMER_ORDER_CREATION_SNAPSHOT",
  "OF_CREATION_SNAPSHOT",
  "TECHNICAL_PIECE_CREATION_SNAPSHOT",
  "AFFAIR_CREATION_SNAPSHOT",
  "STOCK_ARTICLE_CREATION_SNAPSHOT",
] as const;

export type CreationSnapshotDocumentKind = (typeof CREATION_SNAPSHOT_DOCUMENT_KINDS)[number];

export type CreationSnapshotHandlers = Readonly<{
  metadata: RequestHandler;
  preview: RequestHandler;
  download: RequestHandler;
  printIntent: RequestHandler;
}>;

type CreationSnapshotHandlerConfig = Readonly<{
  /** Fixed module-owned aggregate namespace (never derived from a request). */
  entityType: "client" | "fournisseur" | "commande-client" | "ordre-fabrication" | "piece-technique" | "affaire" | "stock-article";
  /** Fixed module-owned internal document kind (never derived from a request). */
  documentKind: CreationSnapshotDocumentKind;
  /** Parses the module's existing `:id` semantics and returns its canonical string form. */
  parseEntityId: (req: Request) => string;
  /**
   * Must use the aggregate's existing read/scope path. Returning false intentionally
   * gives the same 404 for a missing or out-of-scope root before any archive lookup.
   */
  canReadEntity: (entityId: string, req: Request) => Promise<boolean>;
  /** Fixed collection URL used only to construct browser links in the metadata envelope. */
  baseUrl: (entityId: string) => string;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

function actorUserId(req: Request): number {
  const id = req.user?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }
  return id;
}

function archiveId(req: Request): string {
  const id = req.params.documentId;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", "documentId must be a UUID");
  }
  return id;
}

function assertSafeEntityId(value: string): string {
  const entityId = value.trim();
  if (!entityId || entityId.length > 160 || /[\u0000-\u001f\u007f/?#\\]/.test(entityId)) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", "id must be a valid route parameter");
  }
  return entityId;
}

function assertSafeBaseUrl(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#") || /[\r\n]/.test(value)) {
    throw new Error("CREATION_SNAPSHOT_BASE_URL_INVALID");
  }
  return value;
}

async function resolveReadableEntity(config: CreationSnapshotHandlerConfig, req: Request): Promise<string> {
  const entityId = assertSafeEntityId(config.parseEntityId(req));
  if (!(await config.canReadEntity(entityId, req))) {
    // Do not disclose whether an entity exists when an adapter scopes it away.
    throw new HttpError(404, "CREATION_SNAPSHOT_ENTITY_NOT_FOUND", "Ressource introuvable.");
  }
  return entityId;
}

/**
 * Builds the four fixed, read-only creation-snapshot handlers for one aggregate.
 * There is intentionally no issue/reissue handler: creation snapshots are queued only
 * from the aggregate's business create transaction.
 */
export function createCreationSnapshotHandlers(config: CreationSnapshotHandlerConfig): CreationSnapshotHandlers {
  const baseUrlFor = (entityId: string) => assertSafeBaseUrl(config.baseUrl(entityId));

  const metadata: RequestHandler = asyncHandler(async (req, res) => {
    // Routes are authenticated too, but retain the guard here so a future mount
    // cannot accidentally turn archive state into an unauthenticated oracle.
    actorUserId(req);
    const entityId = await resolveReadableEntity(config, req);
    noStore(res);
    res.json(
      await getOfficialDocumentGenerationEnvelope({
        tx: db,
        entityType: config.entityType,
        entityId,
        documentKind: config.documentKind,
        baseUrl: baseUrlFor(entityId),
      })
    );
  });

  const sendPdf = (download: boolean): RequestHandler =>
    asyncHandler(async (req, res) => {
      const actorId = actorUserId(req);
      const documentId = archiveId(req);
      const entityId = await resolveReadableEntity(config, req);
      const file = await readOfficialPdfBytes({
        entityType: config.entityType,
        entityId,
        documentKind: config.documentKind,
        archiveId: documentId,
        actorUserId: actorId,
        eventType: download ? "AUTHORITATIVE_PDF_DOWNLOADED" : "AUTHORITATIVE_PDF_PREVIEWED",
      });
      // The archive writer enforces this invariant. Check it again at the browser
      // boundary so a malformed historical row can never become a response header.
      assertAuthoritativePdfFilename(file.filename);
      setSecureDownloadHeaders(res, {
        filename: file.filename,
        mimeType: "application/pdf",
        download,
      });
      res.setHeader("Content-Length", String(file.bytes.byteLength));
      res.send(file.bytes);
    });

  const printIntent: RequestHandler = asyncHandler(async (req, res) => {
    const actorId = actorUserId(req);
    const documentId = archiveId(req);
    const entityId = await resolveReadableEntity(config, req);
    await recordOfficialPdfPrintIntent({
      entityType: config.entityType,
      entityId,
      documentKind: config.documentKind,
      archiveId: documentId,
      actorUserId: actorId,
    });
    noStore(res);
    res.status(204).send();
  });

  return { metadata, preview: sendPdf(false), download: sendPdf(true), printIntent };
}
