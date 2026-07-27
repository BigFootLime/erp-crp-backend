import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { connect: mocks.poolConnect, query: vi.fn() },
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAuditLog,
}));

import { repoCreateClientContact } from "../module/client/repository/client.repository";

const audit = {
  user_id: 1,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/import-assistant",
  page_key: "import-assistant",
  client_session_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
  mocks.insertAuditLog.mockResolvedValue(undefined);
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    const statement = String(sql);
    if (statement.includes("FROM client_contact_create_idempotency")) {
      return { rows: [] };
    }
    if (statement.includes("SELECT 1 FROM clients")) {
      return { rows: [{ exists: 1 }] };
    }
    if (statement.includes("INSERT INTO contacts")) {
      return {
        rows: [{
          contact_id: "11111111-1111-4111-8111-111111111111",
          first_name: "Daniel",
          last_name: "Leglevic",
          email: "daniel@example.com",
          phone_direct: null,
          phone_personal: null,
          role: null,
          civility: null,
        }],
      };
    }
    return { rows: [] };
  });
});

describe("repoCreateClientContact (#184)", () => {
  it("compare le client_id historique varchar(3) comme du texte lors de la reprise idempotente", async () => {
    await repoCreateClientContact(
      "003",
      {
        first_name: "Daniel",
        last_name: "Leglevic",
        email: "daniel@example.com",
        set_primary: false,
      },
      audit,
      "clipper-contact-003-daniel",
    );

    const replaySql = mocks.clientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("FROM client_contact_create_idempotency"));

    expect(replaySql).toContain("c.client_id::text = $2::text");
    expect(replaySql).not.toContain("c.client_id = $2::uuid");
    expect(mocks.clientRelease).toHaveBeenCalledOnce();
  });
});
