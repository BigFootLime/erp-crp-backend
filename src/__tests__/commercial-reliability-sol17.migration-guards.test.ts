import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patch = fs.readFileSync(
  path.resolve(process.cwd(), "db/patches/20260812_commercial_reliability_sol17.sql"),
  "utf8",
);

describe("SOL-17 commercial migration guards", () => {
  it("creates append-only evidence and idempotency receipts", () => {
    expect(patch).toContain("CREATE TABLE public.commercial_quote_events");
    expect(patch).toContain("CREATE TABLE public.commercial_order_cancellations");
    expect(patch).toContain("CREATE TABLE public.commercial_command_receipts");
    expect(patch).toContain("commercial_quote_events_append_only");
    expect(patch).toContain("commercial_command_receipts_pkey PRIMARY KEY (action, idempotency_key)");
  });

  it("does not fabricate historical commercial events", () => {
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.commercial_quote_events\s+SELECT/i);
    expect(patch).not.toMatch(/UPDATE\s+public\.devis/i);
    expect(patch).not.toMatch(/UPDATE\s+public\.commande_client/i);
  });

  it("keeps structured loss and cancellation vocabularies constrained", () => {
    expect(patch).toContain("commercial_quote_events_reason_ck");
    expect(patch).toContain("commercial_order_cancellations_reason_ck");
    expect(patch).toContain("commercial_quote_reminder_daily_channel_uniq");
    expect(patch).toContain("commercial_quote_discount_content_request_uniq");
    expect(patch).toContain("commercial_quote_discount_decision_uniq");
  });
});
