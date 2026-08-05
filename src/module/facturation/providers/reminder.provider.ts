import crypto from "node:crypto";

export type ReminderProviderMessage = {
  idempotencyKey: string;
  recipient: string;
  subject: string;
  body: string;
  attachmentDocumentId: string | null;
};

export type ReminderProviderResult = {
  provider: "sandbox";
  providerMessageId: string;
  acceptedAt: string;
  recipientHash: string;
};

export interface ReminderProvider {
  readonly name: "sandbox";
  send(message: ReminderProviderMessage): Promise<ReminderProviderResult>;
}

export class ReminderProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;

  constructor(code: string, retryable: boolean, safeMessage: string) {
    super(safeMessage);
    this.name = "ReminderProviderError";
    this.code = code;
    this.retryable = retryable;
    this.safeMessage = safeMessage;
  }
}

/**
 * Deliberately network-free provider. It validates the envelope and returns a
 * deterministic receipt; the recipient address never leaves the process and is
 * not returned or logged. There is intentionally no production provider in this
 * feature branch.
 */
export class SandboxReminderProvider implements ReminderProvider {
  readonly name = "sandbox" as const;

  async send(message: ReminderProviderMessage): Promise<ReminderProviderResult> {
    const recipient = message.recipient.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      throw new ReminderProviderError(
        "REMINDER_RECIPIENT_INVALID",
        false,
        "Le destinataire de la relance n'est plus valide."
      );
    }
    if (!message.subject.trim() || !message.body.trim()) {
      throw new ReminderProviderError(
        "REMINDER_MESSAGE_EMPTY",
        false,
        "Le modèle de relance ne produit pas un message complet."
      );
    }
    const recipientHash = crypto.createHash("sha256").update(recipient).digest("hex");
    const providerMessageId = `sandbox_${crypto
      .createHash("sha256")
      .update(message.idempotencyKey)
      .digest("hex")
      .slice(0, 32)}`;
    return {
      provider: "sandbox",
      providerMessageId,
      acceptedAt: new Date().toISOString(),
      recipientHash,
    };
  }
}

export function createReminderProvider(environment = process.env): ReminderProvider {
  const configured = (environment.ADV_REMINDERS_PROVIDER ?? "sandbox").trim().toLowerCase();
  if (configured !== "sandbox") {
    throw new ReminderProviderError(
      "REMINDER_PROVIDER_NOT_SANDBOX",
      false,
      "Aucun envoi n'est autorisé : le provider doit être configuré en sandbox."
    );
  }
  return new SandboxReminderProvider();
}
