import { z } from "zod";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { bumpRealtimeAuthorizationEpoch } from "../../../shared/realtime/realtime-control-plane";
import { findAuthenticatedAccountState } from "../../auth/repository/auth.repository";
import { SENSITIVE_CAPABILITIES, type SensitiveCapability } from "../domain/sensitive-capabilities";
import { withTransaction } from "../repository/access-control.repository";
import type { AccessAuditContext } from "../types/access-control.types";

const labels: Partial<Record<SensitiveCapability, string>> = {
  "audit.read": "Consulter le journal global", "privacy.manage": "Traiter les demandes RGPD",
  "hr.sensitive.read": "Consulter les données RH sensibles", "hr.sensitive.write": "Modifier les données RH sensibles",
  "finance.validate": "Valider les factures", "finance.issue": "Émettre les factures",
  "finance.credit_issue": "Émettre les avoirs", "finance.payment_allocate": "Affecter les règlements",
  "finance.reporting_financial": "Consulter les données financières", "finance.reporting_client_detail": "Consulter le détail financier client",
  "finance.reporting_export": "Exporter les données financières", "finance.settings_manage": "Configurer la facturation",
  "finance.einvoice_admin": "Configurer la facturation électronique", "finance.einvoice_submit": "Transmettre les factures électroniques",
  "finance.einvoice_reconcile": "Réconcilier les factures électroniques", "finance.accounting_export_execute": "Exporter vers la comptabilité",
  "finance.accounting_export_admin": "Configurer les exports comptables", "finance.reminder_send": "Envoyer les relances",
  "finance.reminder_approve": "Approuver les relances", "finance.reminder_retry": "Relancer un envoi",
  "finance.reminder_policy_manage": "Configurer les relances", "finance.reminder_job_run": "Exécuter les relances",
  "finance.supplier_invoice_match": "Rapprocher les factures fournisseurs", "finance.supplier_invoice_approve": "Approuver les factures fournisseurs",
  "finance.supplier_invoice_dispute": "Traiter un litige fournisseur", "finance.ereporting_submit": "Transmettre les données réglementaires",
};
export const sensitiveCapabilityMutationSchema = z.object({
  params: z.object({ userId: z.coerce.number().int().positive(), capability: z.enum(SENSITIVE_CAPABILITIES) }),
  body: z.object({ granted: z.boolean(), expected_version: z.number().int().nonnegative().safe() }).strict(),
});
type GrantRow = { capability: SensitiveCapability; granted: boolean; version: string };
export async function getSensitiveCapabilityOverview(userId: number) {
  const account = (await pool.query<{ status: string; is_superadmin: boolean }>(
    "SELECT status, COALESCE(is_superadmin, false) AS is_superadmin FROM public.users WHERE id=$1", [userId],
  )).rows[0];
  if (!account) throw new HttpError(404, "USER_NOT_FOUND", "Compte introuvable.");
  const grants = (await pool.query<GrantRow>(
    "SELECT capability, granted, version::text AS version FROM public.app_user_sensitive_capabilities WHERE user_id=$1", [userId],
  )).rows;
  return { user_id: userId, active: account.status === "Active", is_superadmin: account.is_superadmin,
    capabilities: SENSITIVE_CAPABILITIES.map(capability => {
      const row = grants.find(entry => entry.capability === capability);
      return { capability, label: labels[capability] ?? capability, granted: account.is_superadmin || row?.granted === true, version: row ? Number(row.version) : 0 };
    }) };
}
export async function setSensitiveCapability(input: z.infer<typeof sensitiveCapabilityMutationSchema>, audit: AccessAuditContext) {
  const { userId, capability } = input.params;
  const targetState = await findAuthenticatedAccountState(userId);
  if (input.body.granted && (!targetState || targetState.status !== "Active" || !targetState.mfa_factor_id)) {
    throw new HttpError(409, "SENSITIVE_ACCESS_MFA_REQUIRED", "Le compte doit être actif et avoir activé sa double authentification avant cette habilitation.");
  }
  await withTransaction(async tx => {
    const actor = (await tx.query<{ is_superadmin: boolean; status: string }>(
      "SELECT status, COALESCE(is_superadmin, false) AS is_superadmin FROM public.users WHERE id=$1 FOR SHARE", [audit.user_id],
    )).rows[0];
    if (!actor?.is_superadmin || actor.status !== "Active") throw new HttpError(403, "FORBIDDEN", "Accès interdit.");
    const target = (await tx.query<{ is_superadmin: boolean; status: string }>(
      "SELECT status, COALESCE(is_superadmin, false) AS is_superadmin FROM public.users WHERE id=$1 FOR UPDATE", [userId],
    )).rows[0];
    if (!target) throw new HttpError(404, "USER_NOT_FOUND", "Compte introuvable.");
    if (target.is_superadmin) throw new HttpError(409, "SUPERADMIN_CAPABILITIES_PROTECTED", "Les droits du compte de récupération ne se modifient pas dans cette matrice.");
    if (input.body.granted && target.status !== "Active") throw new HttpError(409, "ACCOUNT_INACTIVE", "Le compte doit être actif.");
    const current = (await tx.query<GrantRow>(
      "SELECT capability, granted, version::text AS version FROM public.app_user_sensitive_capabilities WHERE user_id=$1 AND capability=$2 FOR UPDATE", [userId, capability],
    )).rows[0];
    if (current?.granted === input.body.granted) return;
    if (Number(current?.version ?? 0) !== input.body.expected_version) throw new HttpError(409, "SENSITIVE_ACCESS_VERSION_CONFLICT", "Les droits ont changé. Actualisez avant de réessayer.");
    await tx.query(
      `INSERT INTO public.app_user_sensitive_capabilities(user_id,capability,granted,updated_by)
       VALUES($1,$2,$3,$4) ON CONFLICT(user_id,capability) DO UPDATE SET
       granted=EXCLUDED.granted,version=app_user_sensitive_capabilities.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [userId, capability, input.body.granted, audit.user_id],
    );
    await bumpRealtimeAuthorizationEpoch(tx);
    await repoInsertAuditLog({ user_id: audit.user_id, tx, ip: audit.ip, user_agent: audit.user_agent,
      device_type: audit.device_type, os: audit.os, browser: audit.browser,
      body: { event_type: "ACTION", action: "SENSITIVE_CAPABILITY_CHANGED", page_key: "administration-acces",
        entity_type: "account_capability", entity_id: String(userId), path: audit.path,
        details: { capability, granted: input.body.granted }, client_session_id: audit.client_session_id } });
  });
  return getSensitiveCapabilityOverview(userId);
}
