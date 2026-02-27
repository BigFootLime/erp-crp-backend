import type { QuickCommandeConfirmResponse, QuickCommandePreviewResponse } from "../types/quick-commande.types";
import type { ConfirmQuickCommandeBodyDTO, PreviewQuickCommandeBodyDTO } from "../validators/quick-commande.validators";
import { repoConfirmQuickCommande, repoPreviewQuickCommande } from "../repository/quick-commande.repository";

type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

export async function svcPreviewQuickCommande(params: {
  body: PreviewQuickCommandeBodyDTO;
  user_id: number;
}): Promise<QuickCommandePreviewResponse> {
  return repoPreviewQuickCommande(params);
}

export async function svcConfirmQuickCommande(params: {
  body: ConfirmQuickCommandeBodyDTO;
  idempotency_key: string | null;
  audit: AuditContext;
}): Promise<QuickCommandeConfirmResponse> {
  return repoConfirmQuickCommande(params);
}
