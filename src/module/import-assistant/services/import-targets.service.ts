import crypto from "node:crypto";

import { repoCreateClient, type AuditContext as ClientAuditContext } from "../../client/repository/client.repository";
import type { CreateClientDTO } from "../../client/validators/client.validators";
import { createFournisseurSVC } from "../../fournisseurs/services/fournisseurs.service";
import type { CreateFournisseurBodyDTO } from "../../fournisseurs/validators/fournisseurs.validators";
import { createPieceTechniqueSVC } from "../../pieces-techniques/services/pieces-techniques.service";
import type { CreatePieceTechniqueBodyDTO } from "../../pieces-techniques/validators/pieces-techniques.validators";
import { svcCreateMachine } from "../../production/services/production.service";
import type { CreateMachineBodyDTO } from "../../production/validators/production.validators";
import { createStockArticleSVC } from "../../stock/services/stock.service";
import type { CreateArticleBodyDTO } from "../../stock/validators/stock.validators";
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
    case "FOURNISSEUR": {
      const result = await createFournisseurSVC(
        params.normalized_data as CreateFournisseurBodyDTO,
        audit,
        params.idempotency_key
      );
    return { id: result.id, code: result.code ?? null };
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
