import fs from "node:fs/promises";
import path from "node:path";

import nodemailer from "nodemailer";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function readSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const portRaw = (process.env.SMTP_PORT ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  const from = (process.env.SMTP_FROM ?? "").trim();

  if (!host || !portRaw || !user || !pass || !from) return null;

  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;

  const secure = (process.env.SMTP_SECURE ?? "").trim().toLowerCase() === "true" || port === 465;

  return { host, port, secure, user, pass, from };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildPasswordResetEmail(params: {
  username: string;
  resetUrl: string;
  expiresMinutes: number;
}): { subject: string; text: string; html: string } {
  const safeUsername = escapeHtml(params.username);
  const safeUrl = escapeHtml(params.resetUrl);

  const subject = "Réinitialisation de mot de passe — CRP Systems";

  const text =
    `Bonjour ${params.username},\n\n` +
    `Une demande de réinitialisation de mot de passe a été effectuée pour votre compte CRP Systems.\n\n` +
    `Lien (valide ${params.expiresMinutes} minutes) :\n${params.resetUrl}\n\n` +
    `Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email.\n\n` +
    `— CRP Systems`;

  const html = `
  <div style="background:#f6f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
      <div style="padding:18px 18px 8px 18px;border-bottom:1px solid #e2e8f0;">
        <div style="display:flex;align-items:center;gap:12px;">
          <img src="cid:crp-logo" alt="CRP Systems" style="height:34px;width:auto;display:block;" />
          <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">CRP Systems</div>
        </div>
        <div style="margin-top:10px;font-size:18px;font-weight:800;">Réinitialisation de mot de passe</div>
        <div style="margin-top:4px;font-size:12px;color:#475569;">Demande pour l'utilisateur : <b>${safeUsername}</b></div>
      </div>

      <div style="padding:18px;">
        <p style="margin:0 0 10px 0;font-size:13px;line-height:1.5;color:#0f172a;">
          Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
        </p>
        <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;color:#0f172a;">
          Ce lien est valable <b>${params.expiresMinutes} minutes</b> et ne peut être utilisé qu'une seule fois.
        </p>

        <div style="margin:16px 0;">
          <a href="${safeUrl}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:700;">
            Réinitialiser mon mot de passe
          </a>
        </div>

        <div style="margin-top:14px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
          <div style="font-size:12px;color:#334155;">Si le bouton ne fonctionne pas, copiez/collez ce lien :</div>
          <div style="margin-top:6px;font-size:12px;word-break:break-all;color:#0f172a;">${safeUrl}</div>
        </div>

        <p style="margin:16px 0 0 0;font-size:12px;line-height:1.5;color:#475569;">
          Si vous n'êtes pas à l'origine de cette demande, ignorez cet email. Aucune action n'est requise.
        </p>
      </div>

      <div style="padding:12px 18px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;">
        Conseil sécurité : ne partagez jamais vos identifiants. Ce message ne contient aucun mot de passe.
      </div>
    </div>
  </div>
  `.trim();

  return { subject, text, html };
}

async function readLogoAttachment(): Promise<null | { filename: string; content: Buffer; cid: string; contentType: string }>
{
  const candidates = [
    path.resolve("uploads/images/images_logiciel/CRP-Ops.png"),
    path.resolve("/home/bigfootlime/erp-crp/erp-crp-backend/uploads/images/images_logiciel/CRP-Ops.png"),
  ];

  try {
    const found = await (async () => {
      for (const p of candidates) {
        try {
          const content = await fs.readFile(p);
          return { path: p, content };
        } catch {
          // keep trying
        }
      }
      return null;
    })();

    if (!found) return null;

    return {
      filename: "CRP-Ops.png",
      content: found.content,
      cid: "crp-logo",
      contentType: "image/png",
    };
  } catch {
    return null;
  }
}

export async function sendPasswordResetEmail(params: {
  to: string;
  username: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<{ ok: true } | { ok: false; skipped: true } | { ok: false; error: string }> {
  const cfg = readSmtpConfig();
  if (!cfg) {
    return { ok: false, skipped: true };
  }

  const { subject, text, html } = buildPasswordResetEmail({
    username: params.username,
    resetUrl: params.resetUrl,
    expiresMinutes: params.expiresMinutes,
  });

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    debug: false,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
  });

  const logo = await readLogoAttachment();
  const attachments = logo ? [logo] : [];

  try {
    await transporter.sendMail({
      from: cfg.from,
      to: params.to,
      subject,
      text,
      html,
      attachments,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Email send failed";
    return { ok: false, error: msg };
  }
}
