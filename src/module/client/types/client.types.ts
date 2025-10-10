// src/module/client/types/client.types.ts
export type AddressInput = {
  name: string; street: string; house_number?: string | null;
  postal_code: string; city: string; country: string;
};

export type BankInline = { bank_name: string; iban: string; bic: string };

export type PrimaryContactInput = {
  first_name: string; last_name: string; email: string;
  phone_personal?: string | null; role?: string | null; civility?: string | null;
};

export type ClientCreateInput = {
  company_name: string;
  email?: string; phone?: string; website_url?: string;
  siret?: string; vat_number?: string; naf_code?: string;
  status: "prospect" | "client" | "inactif";
  blocked: boolean; reason?: string; creation_date: string;
  payment_mode_ids: string[];
  biller_id?: string | "";
  bank: BankInline;
  observations?: string;
  provided_documents_id?: string;
  bill_address: AddressInput;
  delivery_address: AddressInput;
  primary_contact?: PrimaryContactInput;
};
