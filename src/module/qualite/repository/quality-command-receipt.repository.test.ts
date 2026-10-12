import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  acquireIdempotency,
  saveReceipt,
} from "./quality-command-receipt.repository";
import { qualityRequestHash } from "../domain/quality-policy";
import { createNonConformityDispositionSchema } from "../validators/qualite.validators";
const commandType = "quality.nc.disposition",
  payload = { id: "nc", qty: 20 },
  actor = { user_id: 7 },
  key = "quality-replay-1503";
describe("quality transaction receipts", () => {
  it("locks the actor/key before checking the saved result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await acquireIdempotency({
      client: { query } as unknown as PoolClient,
      actor,
      idempotencyKeyRaw: key,
      commandType,
      requestPayload: payload,
    });
    expect(result.replay).toBeNull();
    expect(query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0][1]).toEqual([`quality:7:${key}`]);
  });
  it("replays the original result and rejects a changed payload", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            request_hash: qualityRequestHash(commandType, payload),
            result_payload: { dispositionId: "original" },
          },
        ],
      });
    const args = {
      client: { query } as unknown as PoolClient,
      actor,
      idempotencyKeyRaw: key,
      commandType,
      requestPayload: payload,
    };
    expect((await acquireIdempotency(args)).replay).toEqual({
      dispositionId: "original",
    });
    await expect(
      acquireIdempotency({ ...args, requestPayload: { ...payload, qty: 21 } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("saves the result in the supplied transaction and scopes requests by actor", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await saveReceipt({
      client: { query } as unknown as PoolClient,
      actor,
      idempotencyKey: key,
      requestHash: "hash",
      commandType,
      aggregateType: "DISPOSITION",
      aggregateId: "disposition",
      requestPayload: payload,
      resultPayload: { dispositionId: "disposition" },
      correlationId: "correlation",
    });
    expect(query.mock.calls[0][1]).toEqual([
      7,
      key,
      "hash",
      commandType,
      "DISPOSITION",
      "disposition",
      JSON.stringify(payload),
      JSON.stringify({ dispositionId: "disposition" }),
      "correlation",
    ]);
  });
  it("accepts the optional command identifier inside the strict disposition body", () => {
    const body = {
      disposition_type: "SCRAP",
      qty: 20,
      unite: "mm",
      idempotency_key: "11111111-1111-4111-8111-111111111111",
    };
    expect(createNonConformityDispositionSchema.parse({ body }).body).toEqual(
      body,
    );
    expect(() =>
      createNonConformityDispositionSchema.parse({
        body: { ...body, idempotency_key: "bad" },
      }),
    ).toThrow();
  });
});
