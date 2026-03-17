type ResendConfig = {
  apiKey: string;
  from: string;
  apiBaseUrl: string;
};

export type EmailAttachment = {
  filename: string;
  content: string | Uint8Array;
  contentType?: string | null;
};

export type ResendSendResult =
  | { ok: true; id?: string }
  | { ok: false; skipped: true }
  | { ok: false; error: string };

function readResendConfig(): ResendConfig | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.RESEND_FROM ?? "").trim();
  const apiBaseUrl = (process.env.RESEND_API_BASE_URL ?? "https://api.resend.com")
    .trim()
    .replace(/\/+$/, "");

  if (!apiKey || !from) return null;
  return { apiKey, from, apiBaseUrl };
}

function truncate(value: string, max = 1200): string {
  const s = value.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function toBase64(value: string | Uint8Array): string {
  if (typeof value === "string") return Buffer.from(value).toString("base64");
  return Buffer.from(value).toString("base64");
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

    const err = rawText
      ? `Resend API error (${res.status}): ${truncate(rawText)}`
      : `Resend API error (${res.status})`;
    return { ok: false, error: err };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Resend API request failed";
    return { ok: false, error: truncate(msg) };
  }
}

export async function sendTransactionalEmail(params: {
  to: string[];
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string | null;
  attachments?: EmailAttachment[];
}): Promise<ResendSendResult> {
  const cfg = readResendConfig();
  if (!cfg) return { ok: false, skipped: true };

  return postResendEmail({
    cfg,
    idempotencyKey: params.idempotencyKey ?? null,
    payload: {
      from: cfg.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      attachments: (params.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: toBase64(attachment.content),
        content_type: attachment.contentType ?? undefined,
      })),
    },
  });
}
