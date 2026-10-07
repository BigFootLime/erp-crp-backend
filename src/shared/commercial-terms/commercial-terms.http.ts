import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../../utils/httpError";
import { assertGedParentLinkWritable } from "../../module/ged/services/ged-parent-authorization.service";
import {
  getGeneralTerms,
  readArchivedGeneralTerms,
  selectGeneralTerms,
} from "./commercial-terms.service";
import {
  selectGeneralTermsSchema,
  type CommercialTermsScope,
} from "./commercial-terms.domain";

const parentTypes = {
  devis: "DEVIS",
  "commande-client": "COMMANDE_CLIENT",
  "commande-fournisseur": "COMMANDE_FOURNISSEUR",
} as const;
function identity(
  req: Request,
  scope: CommercialTermsScope,
): { id: string; actor: number } {
  const raw = req.params.id;
  const valid =
    scope === "commande-fournisseur"
      ? z.string().uuid().safeParse(raw)
      : z
          .string()
          .regex(/^[1-9][0-9]{0,14}$/)
          .safeParse(raw);
  if (!valid.success)
    throw new HttpError(
      400,
      "GENERAL_TERMS_PARENT_ID_INVALID",
      "Identifiant de dossier invalide.",
    );
  if (!Number.isSafeInteger(req.user?.id) || Number(req.user?.id) < 1)
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return {
    id:
      scope === "commande-fournisseur" ? valid.data.toLowerCase() : valid.data,
    actor: Number(req.user?.id),
  };
}
/** Installed under each aggregate's existing read/write/export capability. */
export function generalTermsHandlers(
  scope: CommercialTermsScope,
  documentKind: string,
) {
  const read: RequestHandler = async (req, res, next) => {
    try {
      const { id, actor } = identity(req, scope);
      await assertGedParentLinkWritable(actor, {
        entity_type: parentTypes[scope],
        entity_id: id,
      });
      res.json({ data: await getGeneralTerms(scope, id, actor) });
    } catch (error) {
      next(error);
    }
  };
  const select: RequestHandler = async (req, res, next) => {
    try {
      const { id, actor } = identity(req, scope);
      await assertGedParentLinkWritable(actor, {
        entity_type: parentTypes[scope],
        entity_id: id,
      });
      const body = selectGeneralTermsSchema.safeParse(req.body);
      if (!body.success)
        throw new HttpError(
          422,
          "GENERAL_TERMS_SELECTION_INVALID",
          "Choisissez une version et renseignez le motif de sélection.",
        );
      res.json({ data: await selectGeneralTerms(scope, id, actor, body.data) });
    } catch (error) {
      next(error);
    }
  };
  const download: RequestHandler = async (req, res, next) => {
    try {
      const { id, actor } = identity(req, scope);
      await assertGedParentLinkWritable(actor, {
        entity_type: parentTypes[scope],
        entity_id: id,
      });
      const archive = z.string().uuid().safeParse(req.params.documentId);
      if (!archive.success)
        throw new HttpError(
          400,
          "OFFICIAL_DOCUMENT_ID_INVALID",
          "Identifiant de document invalide.",
        );
      const file = await readArchivedGeneralTerms({
        scope,
        entityId: id,
        archiveId: archive.data,
        documentKind,
        actor,
      });
      if (!file)
        throw new HttpError(
          404,
          "GENERAL_TERMS_NOT_ARCHIVED",
          "Cette ancienne émission ne comporte pas de conditions archivées.",
        );
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="conditions.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, "%27")}`,
      );
      res.send(file.bytes);
    } catch (error) {
      next(error);
    }
  };
  return { read, select, download };
}
