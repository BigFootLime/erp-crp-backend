import db from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";

type Audit = { userId: number; ip: string | null; userAgent: string | null; path: string | null; pageKey: string | null; sessionId: string | null };
export type IndicativeCataloguePrice = { idempotencyKey: string; toolId: number; catalogueId: string; unitPrice: string; currency: string; unit: string; source: { document: string; sha256: string; page: number; rect: number[]; sourceDate: string | null; taxBasis: "HT" | "UNKNOWN" } };

export async function recordToolIndicativeCataloguePrice(input: IndicativeCataloguePrice, audit: Audit): Promise<{ inserted: boolean }> {
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const schema = await tx.query<{ available: boolean }>("SELECT to_regclass('public.outillage_tool_indicative_catalogue_price') IS NOT NULL AS available");
    if (!schema.rows[0]?.available) throw new HttpError(503, "OUTILLAGE_INDICATIVE_PRICE_SCHEMA_UNAVAILABLE", "Le schéma des prix catalogue indicatifs n'est pas appliqué sur cette base.");
    const eligible = await tx.query("SELECT 1 FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id AND f.actif=true AND f.status NOT IN ('archive','inactif') JOIN public.fournisseur_domaine_lien dl ON dl.fournisseur_id=f.id AND dl.domaine_code='outillage' WHERE c.id=$1::uuid AND c.type='OUTILLAGE' AND c.actif=true AND EXISTS(SELECT 1 FROM public.gestion_outils_outil o WHERE o.id_outil=$2) FOR KEY SHARE", [input.catalogueId, input.toolId]);
    if (!eligible.rows[0]) throw new HttpError(422, "OUTILLAGE_INDICATIVE_PRICE_CATALOGUE_INVALID", "L'offre Outillage active ou l'outil est introuvable.");
    const inserted = await tx.query("INSERT INTO public.outillage_tool_indicative_catalogue_price (idempotency_key,id_outil,catalogue_id,unit_price,currency,unit,price_type,source_document,source_sha256,source_page,source_rect,source_date,tax_basis,imported_by) VALUES ($1,$2,$3::uuid,$4::numeric,$5,$6,'CATALOGUE_INDICATIF',$7,$8,$9,$10::jsonb,$11::date,$12,$13) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id", [input.idempotencyKey,input.toolId,input.catalogueId,input.unitPrice,input.currency,input.unit,input.source.document,input.source.sha256.toLowerCase(),input.source.page,JSON.stringify(input.source.rect),input.source.sourceDate,input.source.taxBasis,audit.userId]);
    if (inserted.rows[0]) {
      await repoInsertAuditLog({ user_id:audit.userId, tx, ip:audit.ip, user_agent:audit.userAgent, device_type:null, os:null, browser:null, body:{ event_type:"ACTION", action:"outillage.indicative-catalogue-price.record", page_key:audit.pageKey, entity_type:"OUTIL", entity_id:String(input.toolId), path:audit.path, client_session_id:audit.sessionId, details:{ catalogue_id:input.catalogueId, price_kind:"CATALOGUE_INDICATIF", source_date:input.source.sourceDate, tax_basis:input.source.taxBasis } } });
      await enqueueEntityChanged(tx,{entityType:"OUTIL",entityId:String(input.toolId),action:"updated",module:"outillage",at:new Date().toISOString(),invalidateKeys:["outils","outil-pricing","outils-fournisseurs"]},{deduplicationKey:`outillage:indicative-price:${input.idempotencyKey}`});
    }
    return { inserted: Boolean(inserted.rows[0]) };
  });
}
