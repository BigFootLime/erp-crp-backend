export type CommandeArRecipientSuggestion = {
  key: string;
  email: string;
  label: string;
  source: "CLIENT" | "CONTACT";
  contact_id: string | null;
  is_default: boolean;
};

export type CommandeArDraft = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  document_name: string;
  subject: string;
  generated_at: string;
  generated_by: number | null;
  status: "GENERATED" | "SENT" | "FAILED";
  sent_at: string | null;
  preview_path: string;
  recipient_suggestions: CommandeArRecipientSuggestion[];
};

export type CommandeArSendResult = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  status: "AR_ENVOYEE";
  sent_at: string;
  recipient_emails: string[];
  email_provider_id: string | null;
};
