import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  read: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../config/database", () => ({
  default: { query: mocks.read, connect: mocks.connect },
}));
vi.mock("../../../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: async (
    tx: unknown,
    run: (client: unknown) => unknown,
  ) => run(tx),
}));
import { repoCreateNonConformityDisposition } from "./qualite.repository";
import { qualityRequestHash } from "../domain/quality-policy";
it("returns an already committed disposition without another movement, disposition or audit write", async () => {
  const id = "11111111-1111-4111-8111-111111111111",
    body = {
      disposition_type: "SCRAP" as const,
      qty: 100,
      unite: "mm",
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    };
  mocks.connect.mockResolvedValue({ query: mocks.query });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("quality_command_receipts"))
      return {
        rows: [
          {
            request_hash: qualityRequestHash("quality.nc.disposition", {
              id,
              ...body,
            }),
            result_payload: { dispositionId: "existing" },
          },
        ],
      };
    throw Error("Unexpected transaction work on replay: " + sql);
  });
  mocks.read.mockResolvedValue({
    rows: [
      {
        id: "existing",
        non_conformity_id: id,
        disposition_type: "SCRAP",
        qty: 100,
        unite: "mm",
        decided_by_id: null,
        created_by_id: null,
        updated_by_id: null,
      },
    ],
  });
  const result = await repoCreateNonConformityDisposition({
    id,
    body,
    audit: { user_id: 1 } as never,
  });
  expect(result.id).toBe("existing");
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
