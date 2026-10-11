import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

// Called within the directory-verification transaction, with the issuer lock held.
// Qualification is written only after the provider confirmed an active SIREN/address pair.
export async function qualifyIssuerElectronicAddress(client: PoolClient, params: {
  issuerId: string; scheme: string; value: string; identifier: string; actorId: number | null;
}) {
  const currentResult = await client.query<{
    mention_set_id: string; effective_from: string; effective_to: string | null; today: string;
    electronic_address_directory_entry_id: string | null; verified_at: string | null;
  }>(
    `SELECT mention_set_id::text, effective_from::text, effective_to::text, CURRENT_DATE::text AS today,
            electronic_address_directory_entry_id, electronic_address_verified_at::text AS verified_at
     FROM public.finance_legal_mentions WHERE biller_id::text = $1
       AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     FOR UPDATE`, [params.issuerId]
  );
  const current = currentResult.rows[0];
  if (!current) throw new HttpError(409, "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED", "Les mentions légales de l’émetteur ne sont plus applicables. Actualisez la configuration.");
  if (current.electronic_address_directory_entry_id === params.identifier && current.verified_at) {
    return { rows: [{ verified_at: current.verified_at }] };
  }
  if (current.effective_from === current.today) {
    // A version created today can receive its first qualification. Never replace a
    // previously qualified address in that daily version; issued snapshots stay immutable.
    if (current.verified_at) throw new HttpError(409, "FINANCE_ISSUER_ROUTING_ALREADY_QUALIFIED_TODAY", "Une autre adresse a déjà été qualifiée aujourd’hui. La modification doit prendre effet dans une nouvelle période légale.");
    return client.query<{ verified_at: string }>(
      `UPDATE public.finance_legal_mentions SET electronic_address_scheme = $2,
         electronic_address_value = $3, electronic_address_directory_entry_id = $4,
         electronic_address_verified_at = clock_timestamp()
       WHERE mention_set_id = $1::uuid RETURNING electronic_address_verified_at::text AS verified_at`,
      [current.mention_set_id, params.scheme, params.value, params.identifier]
    );
  }
  // Close the old period and copy its legal identity to a new dated version. No
  // invoice, previous routing, bank account or statutory mention is rewritten.
  await client.query("UPDATE public.finance_legal_mentions SET effective_to = CURRENT_DATE WHERE mention_set_id = $1::uuid", [current.mention_set_id]);
  return client.query<{ verified_at: string }>(
    `INSERT INTO public.finance_legal_mentions (
       biller_id, version, effective_from, effective_to,
       legal_form, share_capital, share_capital_currency, rcs_city, rcs_number, siren, siret, vat_number, ape_code,
       late_penalty_rate, late_penalty_basis, recovery_indemnity, early_discount_rate, early_discount_basis,
       vat_on_receipts, vat_exempt_293b, retention_of_title, extra_mentions, created_by,
       electronic_address_scheme, electronic_address_value, electronic_address_directory_entry_id, electronic_address_verified_at
     ) SELECT m.biller_id, (SELECT max(v.version) + 1 FROM public.finance_legal_mentions v WHERE v.biller_id = m.biller_id),
       CURRENT_DATE, $6::date,
       m.legal_form, m.share_capital, m.share_capital_currency, m.rcs_city, m.rcs_number, m.siren, m.siret, m.vat_number, m.ape_code,
       m.late_penalty_rate, m.late_penalty_basis, m.recovery_indemnity, m.early_discount_rate, m.early_discount_basis,
       m.vat_on_receipts, m.vat_exempt_293b, m.retention_of_title, m.extra_mentions, $5,
       $2, $3, $4, clock_timestamp()
     FROM public.finance_legal_mentions m WHERE m.mention_set_id = $1::uuid
     RETURNING electronic_address_verified_at::text AS verified_at`,
    [current.mention_set_id, params.scheme, params.value, params.identifier, params.actorId, current.effective_to]
  );
}
