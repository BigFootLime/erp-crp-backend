type ResendConfig = {
  apiKey: string;
  from: string;
  apiBaseUrl: string;
};

type ResendSendResult =
  | { ok: true; id?: string }
  | { ok: false; skipped: true }
  | { ok: false; error: string };

function readResendConfig(): ResendConfig | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.RESEND_FROM ?? "").trim();
  const apiBaseUrl = (process.env.RESEND_API_BASE_URL ?? "https://api.resend.com").trim().replace(/\/+$/, "");

  if (!apiKey || !from) return null;
  return { apiKey, from, apiBaseUrl };
}

function buildLogoUrl(): string | null {
  const explicit = (process.env.EMAIL_LOGO_URL ?? "").trim();
  if (explicit) return explicit;

  const backendUrl = (process.env.BACKEND_URL ?? "https://erp-backend.croix-rousse-precision.fr").trim().replace(/\/+$/, "");
  if (!backendUrl) return null;

  return `${backendUrl}/images/images_logiciel/CRP-Ops.png`;
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
  logoSrc?: string | null;
}): { subject: string; text: string; html: string } {
  const safeUsername = escapeHtml(params.username);
  const safeUrl = escapeHtml(params.resetUrl);
  const safeLogoSrc = params.logoSrc ? escapeHtml(params.logoSrc) : null;

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
          ${safeLogoSrc ? `<img src="${safeLogoSrc}" alt="CRP Systems" style="height:34px;width:auto;display:block;" />` : ""}
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

function truncate(value: string, max = 1000): string {
  const s = value.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

async function postResendEmail(params: {
  cfg: ResendConfig;
  payload: unknown;
  idempotencyKey?: string | null;
}): Promise<ResendSendResult> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.cfg.apiKey}`,
      "Content-Type": "application/json",
    };

    const key = (params.idempotencyKey ?? "").trim();
    if (key) headers["Idempotency-Key"] = key.slice(0, 256);

    const res = await fetch(`${params.cfg.apiBaseUrl}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.payload),
    });

    const rawText = await (async () => {
      try {
        return (await res.text()).trim();
      } catch {
        return "";
      }
    })();

    if (res.ok) {
      try {
        const parsed = rawText ? (JSON.parse(rawText) as unknown) : null;
        if (parsed && typeof parsed === "object" && "id" in parsed && typeof (parsed as { id: unknown }).id === "string") {
          return { ok: true, id: (parsed as { id: string }).id };
        }
      } catch {
        // ignore
      }
      return { ok: true };
    }

    const err = rawText ? `Resend API error (${res.status}): ${truncate(rawText, 1200)}` : `Resend API error (${res.status})`;
    return { ok: false, error: err };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Resend API request failed";
    return { ok: false, error: truncate(msg, 1200) };
  }
}

export async function sendPasswordResetEmail(params: {
  to: string;
  username: string;
  resetUrl: string;
  expiresMinutes: number;
  request_id?: string | null;
}): Promise<ResendSendResult> {
  const cfg = readResendConfig();
  if (!cfg) {
    return { ok: false, skipped: true };
  }

  const logoUrl = buildLogoUrl();

  // Prefer inline logo when possible (CID). If it fails (e.g. logo URL not reachable by Resend),
  // retry once without attachments and with remote logo.
  if (logoUrl) {
    const inline = buildPasswordResetEmail({
      username: params.username,
      resetUrl: params.resetUrl,
      expiresMinutes: params.expiresMinutes,
      logoSrc: "cid:crp-logo",
    });

    const inlineRes = await postResendEmail({
      cfg,
      idempotencyKey: params.request_id ?? null,
      payload: {
        from: cfg.from,
        to: [params.to],
        subject: inline.subject,
        text: inline.text,
        html: inline.html,
        attachments: [
          {
            filename: "CRP-Ops.png",
            path: logoUrl,
            content_type: "image/png",
            content_id: "crp-logo",
          },
        ],
      },
    });

    if (inlineRes.ok) return inlineRes;

    const remote = buildPasswordResetEmail({
      username: params.username,
      resetUrl: params.resetUrl,
      expiresMinutes: params.expiresMinutes,
      logoSrc: logoUrl,
    });

    return await postResendEmail({
      cfg,
      idempotencyKey: params.request_id ?? null,
      payload: {
        from: cfg.from,
        to: [params.to],
        subject: remote.subject,
        text: remote.text,
        html: remote.html,
      },
    });
  }

  const noLogo = buildPasswordResetEmail({
    username: params.username,
    resetUrl: params.resetUrl,
    expiresMinutes: params.expiresMinutes,
  });

  return await postResendEmail({
    cfg,
    idempotencyKey: params.request_id ?? null,
    payload: {
      from: cfg.from,
      to: [params.to],
      subject: noLogo.subject,
      text: noLogo.text,
      html: noLogo.html,
    },
  });
}
