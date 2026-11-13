import type { RequestHandler } from "express";
import pool from "../../../config/database";
import { repoIsSuperadmin } from "../../access-control/repository/access-control.repository";
import { HttpError } from "../../../utils/httpError";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Preserve the privacy of preparation evidence on every existing document and
 * version action, including histories, revision reuse and lifecycle mutations. */
export const requireCutoverParentAccess: RequestHandler = (req, _res, next) => {
  // Authentication belongs to the parent API router/capability guard. Do not
  // perform a document lookup before that guard can return its normal 401.
  if (!req.user?.id) { next(); return; }
  const documentId = typeof req.params.id === "string" ? req.params.id : null;
  const versionId = typeof req.params.versionId === "string" ? req.params.versionId : null;
  if (!(documentId && uuid.test(documentId)) && !(versionId && uuid.test(versionId))) { next(); return; }
  void (async () => {
    const privateParent = await pool.query<{ private: boolean }>("SELECT EXISTS(SELECT 1 FROM public.ged_document_links link WHERE upper(link.entity_type)='CUTOVER_ROW' AND (link.document_id=$1::uuid OR link.document_id=(SELECT document_id FROM public.ged_document_versions WHERE id=$2::uuid))) AS private", [documentId, versionId]);
    if (privateParent.rows[0]?.private && (!req.user?.id || !await repoIsSuperadmin(req.user.id))) throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");
  })().then(() => next()).catch(next);
};
