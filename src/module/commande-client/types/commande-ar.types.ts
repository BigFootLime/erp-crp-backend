export type CommandeArRecipientSuggestion = {
  key: string;
  email: string;
  label: string;
  source: "CLIENT" | "CONTACT";
  contact_id: string | null;
  contact_name?: string | null;
  is_default: boolean;
};

export type CommandeArDraft = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  document_name: string;
  reference: string;
  series_number: number;
  version_number: number;
  subject: string;
  default_message: string;
  generated_at: string;
  generated_by: number | null;
  status: "GENERATED" | "SENDING" | "SENT" | "FAILED";
  sent_at: string | null;
  preview_path: string;
  is_obsolete: boolean;
  reused_draft: boolean;
  recipient_suggestions: CommandeArRecipientSuggestion[];
};

export type CommandeArVersionsResult = {
  current: CommandeArDraft | null;
  versions: CommandeArDraft[];
};

export type CommandeArSendResult = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  reference: string;
  status: "AR_ENVOYE";
  sent_at: string;
  recipient_emails: string[];
  email_provider_id: string | null;
  already_sent?: boolean;
};
