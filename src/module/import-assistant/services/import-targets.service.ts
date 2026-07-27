import crypto from "node:crypto";

import {
  repoCreateClient,
  repoCreateClientContact,
  repoPatchClient,
  type AuditContext as ClientAuditContext,
} from "../../client/repository/client.repository";
import type {
  ClientPatchDTO,
  CreateClientContactBodyDTO,
  CreateClientDTO,
} from "../../client/validators/client.validators";
import { createCommandeFournisseurSVC } from "../../commande-fournisseur/services/commande-fournisseur.service";
import type { CreateCommandeBodyDTO } from "../../commande-fournisseur/validators/commande-fournisseur.validators";
import { createFournisseurSVC } from "../../fournisseurs/services/fournisseurs.service";
import type { CreateFournisseurBodyDTO } from "../../fournisseurs/validators/fournisseurs.validators";
import { createPieceTechniqueSVC } from "../../pieces-techniques/services/pieces-techniques.service";
import type { CreatePieceTechniqueBodyDTO } from "../../pieces-techniques/validators/pieces-techniques.validators";
import { svcCreateMachine } from "../../production/services/production.service";
import type { CreateMachineBodyDTO } from "../../production/validators/production.validators";
import {
  createStockArticleSVC,
  createStockMovementSVC,
  postStockMovementSVC,
  resolveStockOpeningReferencesSVC,
} from "../../stock/services/stock.service";
import type {
  CreateArticleBodyDTO,
  CreateMovementBodyDTO,
} from "../../stock/validators/stock.validators";
import { HttpError } from "../../../utils/httpError";
import type {
  ImportAuditContext,
  ImportEntityType,
  ImportTargetResult,
} from "../types/import-assistant.types";

function deterministicUuid(input: string): string {
  const bytes = crypto.createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function importRowIdempotencyKey(params: {
  source_system: string;
  entity_type: ImportEntityType;
  legacy_key: string;
}): string {
  return deterministicUuid(`${params.source_system}|${params.entity_type}|${params.legacy_key}`);
}

export async function createImportTarget(params: {
  entity_type: ImportEntityType;
  normalized_data: Record<string, unknown>;
  idempotency_key: string;
  parent_target_id?: string | null;
  parent_target_code?: string | null;
  audit: ImportAuditContext;
}): Promise<ImportTargetResult> {
  const audit = params.audit as ClientAuditContext;
  switch (params.entity_type) {
    case "CLIENT": {
      const result = await repoCreateClient(
        params.normalized_data as CreateClientDTO,
        audit,
        params.idempotency_key
      );
      return { id: result.client_id, code: result.client_code };
    }
    case "CLIENT_ENRICHISSEMENT": {
      if (!params.parent_target_id) {
        throw new HttpError(409, "IMPORT_CLIENT_TARGET_MISSING", "Le client CERP à enrichir est introuvable.");
      }
      const patch = params.normalized_data as ClientPatchDTO;
      await repoPatchClient(
        params.parent_target_id,
        patch,
        new Set(Object.keys(patch)),
        audit
      );
      return { id: params.parent_target_id, code: params.parent_target_code ?? null };
    }
    case "CLIENT_CONTACT": {
      if (!params.parent_target_id) {
        throw new HttpError(409, "IMPORT_CLIENT_TARGET_MISSING", "Le client CERP du contact est introuvable.");
      }
      const { client_legacy_code: _clientLegacyCode, ...contact } = params.normalized_data as
        CreateClientContactBodyDTO & { client_legacy_code: string };
      const result = await repoCreateClientContact(
        params.parent_target_id,
        contact,
        audit,
        params.idempotency_key
      );
      return { id: result.contact_id, code: null };
    }
    case "FOURNISSEUR": {
      const result = await createFournisseurSVC(
        params.normalized_data as CreateFournisseurBodyDTO,
        audit,
        params.idempotency_key
      );
    return { id: result.id, code: result.code ?? null };
    }
    case "FOURNISSEUR_COMMANDE": {
      if (!params.parent_target_id) {
        throw new HttpError(
          409,
          "IMPORT_FOURNISSEUR_TARGET_MISSING",
          "Le fournisseur CERP de la commande est introuvable."
        );
      }
      const {
        fournisseur_legacy_code: _fournisseurLegacyCode,
        date_commande_source: _dateCommandeSource,
        ...commande
      } = params.normalized_data as CreateCommandeBodyDTO & {
        fournisseur_legacy_code: string;
        date_commande_source: string;
      };
      const result = await createCommandeFournisseurSVC(
        {
          ...commande,
          fournisseur_id: params.parent_target_id,
          idempotency_key: params.idempotency_key,
        },
        audit
      );
      return { id: result.id, code: result.code };
    }
    case "ARTICLE": {
      const result = await createStockArticleSVC(
        params.normalized_data as CreateArticleBodyDTO,
        audit,
        params.idempotency_key,
        false
      );
      return { id: result.id, code: result.code };
    }
    case "STOCK_INITIAL": {
      if (!params.parent_target_id) {
        throw new HttpError(
          409,
          "IMPORT_ARTICLE_TARGET_MISSING",
          "L’article CERP du stock d’ouverture est introuvable."
        );
      }
      const data = params.normalized_data as {
        article_legacy_code: string;
        quantity: number;
        magasin_code: string;
        emplacement_code: string;
        cutoff_date: string;
        unite?: string;
        notes?: string;
      };
      const references = await resolveStockOpeningReferencesSVC([{
        key: "stock-opening",
        article_id: params.parent_target_id,
        magasin_code: data.magasin_code,
        emplacement_code: data.emplacement_code,
      }]);
      const reference = references.get("stock-opening");
      if (!reference || reference.issue || !reference.magasin_id || !reference.emplacement_id) {
        throw new HttpError(
          409,
          reference?.issue?.code ?? "STOCK_REFERENCE_UNRESOLVED",
          reference?.issue?.message ?? "Le magasin ou l’emplacement CERP n’a pas pu être validé."
        );
      }

      const provenance = [
        `Migration CLIPPER — stock d’ouverture au ${data.cutoff_date}.`,
        "Solde reconstitué : entrées + retours − sorties ; mouvements annulés ignorés.",
        `Article source : ${data.article_legacy_code}.`,
        data.notes,
      ].filter(Boolean).join(" ");
      const movementBody: CreateMovementBodyDTO = {
        movement_type: "ADJUSTMENT",
        effective_at: `${data.cutoff_date}T23:59:59Z`,
        source_document_type: "CLIPPER_STOCK_OPENING",
        source_document_id: `${data.article_legacy_code}|${data.cutoff_date}`.slice(0, 120),
        reason_code: "OPENING_BALANCE",
        notes: provenance,
        idempotency_key: `${params.idempotency_key}:create`,
        lines: [{
          article_id: params.parent_target_id,
          qty: data.quantity,
          ...(data.unite ? { unite: data.unite } : {}),
          dst_magasin_id: reference.magasin_id,
          dst_emplacement_id: reference.emplacement_id,
          direction: "IN",
          note: `Stock d’ouverture CLIPPER — ${data.cutoff_date}`,
        }],
      };
      const draft = await createStockMovementSVC(movementBody, params.audit);
      const posted = await postStockMovementSVC(
        draft.movement.id,
        {},
        params.audit,
        `${params.idempotency_key}:post`
      );
      if (!posted) {
        throw new HttpError(
          409,
          "STOCK_OPENING_POST_FAILED",
          "Le mouvement d’ouverture n’a pas pu être comptabilisé."
        );
      }
      return { id: posted.movement.id, code: posted.movement.movement_no };
    }
    case "PIECE_TECHNIQUE": {
      const result = await createPieceTechniqueSVC(
        params.normalized_data as CreatePieceTechniqueBodyDTO,
        audit,
        params.idempotency_key
      );
      return { id: result.id, code: result.code_piece };
    }
    case "MACHINE": {
      const result = await svcCreateMachine({
        body: params.normalized_data as CreateMachineBodyDTO,
        image_path: null,
        idempotency_key: params.idempotency_key,
        audit,
      });
      return { id: result.id, code: result.code };
    }
    default:
      throw new HttpError(409, "IMPORT_TARGET_DISABLED", "Ce domaine n’est pas encore ouvert à la confirmation.");
  }
}
