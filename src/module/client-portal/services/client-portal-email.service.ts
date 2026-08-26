import { sendTransactionalEmail } from "../../../shared/email/resend.service";

type EmailDelivery =
  | { status: "SENT"; provider_id: string | null }
  | { status: "NOT_CONFIGURED"; provider_id: null }
  | { status: "FAILED"; provider_id: null };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function portalBaseUrl(): string {
  return (process.env.CLIENT_PORTAL_PUBLIC_URL ?? "https://cerp.croix-rousse-precision.fr")
    .trim()
    .replace(/\/+$/, "");
}

export function buildPortalUrl(path: string): string {
  return `${portalBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function sendPortalAccessEmail(input: {
  to: string;
  displayName: string;
  path: string;
  kind: "INVITATION" | "PASSWORD_RESET";
  expiresMinutes: number;
  idempotencyKey: string;
}): Promise<EmailDelivery> {
  const url = buildPortalUrl(input.path);
  const action = input.kind === "INVITATION" ? "Activer mon accès client" : "Réinitialiser mon mot de passe";
  const subject = input.kind === "INVITATION"
    ? "Votre accès au portail client CERP"
    : "Réinitialisation de votre accès au portail client CERP";
  const safeName = escapeHtml(input.displayName);
  const safeUrl = escapeHtml(url);
  const text =
    `Bonjour ${input.displayName},\n\n${action} : ${url}\n\n` +
    `Ce lien est à usage unique et expire dans ${input.expiresMinutes} minutes.\n` +
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.";
  const html = `<div style="font-family:Arial,sans-serif;color:#111827;max-width:560px;margin:auto">` +
    `<h1 style="font-size:20px">Portail client CERP</h1>` +
    `<p>Bonjour ${safeName},</p>` +
    `<p>${escapeHtml(action)}. Ce lien à usage unique expire dans ${input.expiresMinutes} minutes.</p>` +
    `<p><a href="${safeUrl}" style="display:inline-block;background:#111827;color:#fff;padding:10px 14px;text-decoration:none;border-radius:6px">${escapeHtml(action)}</a></p>` +
    `<p style="font-size:12px;color:#6b7280;word-break:break-all">${safeUrl}</p>` +
    `<p style="font-size:12px;color:#6b7280">Ignorez ce message si vous n'êtes pas à l'origine de la demande.</p>` +
    `</div>`;

  const delivery = await sendTransactionalEmail({
    to: [input.to],
    subject,
    text,
    html,
    idempotencyKey: input.idempotencyKey,
  });
  if ("skipped" in delivery) return { status: "NOT_CONFIGURED", provider_id: null };
  if (!delivery.ok) return { status: "FAILED", provider_id: null };
  return { status: "SENT", provider_id: delivery.id ?? null };
}

