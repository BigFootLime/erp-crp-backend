import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function canonicalStockCommandPayload(command: string, payload: unknown): string {
  return JSON.stringify(canonicalize({ command, payload }));
}

export function hashStockCommand(command: string, payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalStockCommandPayload(command, payload)).digest("hex");
}

export function normalizeIdempotencyKey(raw: string | null | undefined): string {
  const key = raw?.trim() ?? "";
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key must contain between 8 and 200 characters"
    );
  }
  return key;
}
