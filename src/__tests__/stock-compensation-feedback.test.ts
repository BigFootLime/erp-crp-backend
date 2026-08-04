import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: database }));

import { hashStockCommand } from "../module/stock/domain/stock-command";
import {
  beginStockCommand,
  repoCompensateMovement,
  repoPreviewMovementCompensation,
  type AuditContext,
} from "../module/stock/repository/stock.repository";

const ORIGINAL_ID = "11111111-1111-4111-8111-111111111111";
const COMPENSATION_ID = "22222222-2222-4222-8222-222222222222";
const ARTICLE_ID = "33333333-3333-4333-8333-333333333333";
const MAGASIN_ID = "44444444-4444-4444-8444-444444444444";
const POSTED_AT = "2026-08-04T08:00:00.000Z";
const BODY = {
  reason: "Correction du comptage atelier",
  expected_posted_at: POSTED_AT,
};
const AUDIT: AuditContext = {
  user_id: 7,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/stock/movements/:id/compensate",
  page_key: "stock-movement-detail",
  client_session_id: null,
};

function movementRow(args: {
  id?: string;
  movementNo?: string;
  status?: string;
  postedAt?: string | null;
  movementType?: string;
} = {}) {
  return {
    id: args.id ?? ORIGINAL_ID,
    movement_no: args.movementNo ?? "MVT-00042",
    movement_type: args.movementType ?? "IN",
    status: args.status ?? "POSTED",
    article_id: ARTICLE_ID,
    stock_level_id: null,
    stock_batch_id: null,
    qty: 5,
    effective_at: "2026-08-04T07:55:00.000Z",
    posted_at: args.postedAt === undefined ? POSTED_AT : args.postedAt,
    source_document_type: "MANUAL",
    source_document_id: null,
    reason_code: "RECEIPT",
    correlation_id: null,
    reversal_of_id: args.id === COMPENSATION_ID ? ORIGINAL_ID : null,
    notes: null,
    created_at: "2026-08-04T07:50:00.000Z",
    updated_at: "2026-08-04T08:00:00.000Z",
    created_by: 7,
    updated_by: 7,
    posted_by: 7,
  };
}

function movementLine(movementId = ORIGINAL_ID) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    movement_id: movementId,
    line_no: 1,
    article_id: ARTICLE_ID,
    article_code: "ART-001",
    article_designation: "Article test",
    lot_id: null,
    lot_code: null,
    qty: 5,
    unite: "u",
    unit_cost: null,
    currency: null,
    src_magasin_id: null,
    src_magasin_code: null,
    src_magasin_name: null,
    src_emplacement_id: null,
    src_emplacement_code: null,
    src_emplacement_name: null,
    dst_magasin_id: MAGASIN_ID,
    dst_magasin_code: "MAG-01",
    dst_magasin_name: "Magasin principal",
    dst_emplacement_id: 1,
    dst_emplacement_code: "RACK-01",
    dst_emplacement_name: "Rack 01",
    note: null,
    direction: null,
  };
}

function mockMovementQueries(args: {
  originalPostedAt?: string | null;
  existingCompensation?: { id: string; movement_no: string; status: string } | null;
  requestedMovementId?: string;
} = {}) {
  database.query.mockImplementation(async (sql: unknown, values?: unknown[]) => {
    const text = String(sql);
    const requestedId = String(values?.[0] ?? args.requestedMovementId ?? ORIGINAL_ID);
    if (text.includes("WHERE id = $1::uuid")) {
      return {
        rows: [
          requestedId === COMPENSATION_ID
            ? movementRow({
                id: COMPENSATION_ID,
                movementNo: "MVT-COMP-00042",
                status: "DRAFT",
                postedAt: null,
                movementType: "OUT",
              })
            : movementRow({ postedAt: args.originalPostedAt }),
        ],
      };
    }
    if (text.includes("FROM public.stock_movement_lines l")) {
      return { rows: [movementLine(requestedId)] };
    }
    if (text.includes("FROM public.stock_movement_documents md")) return { rows: [] };
    if (text.includes("FROM public.stock_movement_event_log")) return { rows: [] };
    if (text.includes("WHERE reversal_of_id = $1::uuid")) {
      return { rows: args.existingCompensation ? [args.existingCompensation] : [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  database.query.mockReset();
  database.connect.mockReset();
});

describe("BUG-CERP-0014 stock compensation feedback", () => {
  it("returns an explicit, authoritative eligible terminal state", async () => {
    mockMovementQueries();

    const preview = await repoPreviewMovementCompensation(ORIGINAL_ID, BODY);

    expect(preview).toMatchObject({
      authoritative: true,
      original_movement_id: ORIGINAL_ID,
      outcome: "ELIGIBLE",
      compensable: true,
      blockers: [],
      existing_compensation: null,
      proposed_movement: {
        movement_type: "OUT",
        source_document_type: "STOCK_COMPENSATION",
        source_document_id: ORIGINAL_ID,
      },
    });
    expect(preview?.as_of).toEqual(expect.any(String));
    expect(preview?.prerequisites.every((item) => item.satisfied)).toBe(true);
  });

  it("explains a missing posting timestamp in French without proposing a write", async () => {
    mockMovementQueries({ originalPostedAt: null });

    const preview = await repoPreviewMovementCompensation(ORIGINAL_ID, BODY);

    expect(preview).toMatchObject({
      outcome: "INELIGIBLE",
      compensable: false,
      proposed_movement: null,
    });
    expect(preview?.blockers).toContainEqual({
      code: "POSTED_AT_MISSING",
      message: expect.stringMatching(/date de comptabilisation est absente/i),
    });
    expect(preview?.prerequisites).toContainEqual(
      expect.objectContaining({
        code: "POSTED_AT_MISSING",
        satisfied: false,
      })
    );
  });

  it("returns an existing compensation as a linkable terminal state", async () => {
    const existingCompensation = {
      id: COMPENSATION_ID,
      movement_no: "MVT-COMP-00042",
      status: "DRAFT",
    };
    mockMovementQueries({ existingCompensation });

    const preview = await repoPreviewMovementCompensation(ORIGINAL_ID, BODY);

    expect(preview).toMatchObject({
      outcome: "ALREADY_COMPENSATED",
      compensable: false,
      existing_compensation: existingCompensation,
      proposed_movement: null,
    });
    expect(preview?.blockers).toContainEqual({
      code: "COMPENSATION_ALREADY_EXISTS",
      message: expect.stringMatching(/ouvrez-la au lieu de créer un doublon/i),
    });
  });

  it("replays a double action with the same intent key without creating another movement", async () => {
    const requestHash = hashStockCommand("MOVEMENT_COMPENSATE", {
      movement_id: ORIGINAL_ID,
      ...BODY,
    });
    const clientQuery = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.stock_command_receipts")) {
        return {
          rows: [
            {
              request_hash: requestHash,
              resource_type: "stock_movement",
              resource_id: COMPENSATION_ID,
              result_payload: {
                compensation_movement_id: COMPENSATION_ID,
                reversal_of_id: ORIGINAL_ID,
                status: "DRAFT",
              },
              correlation_id: "66666666-6666-4666-8666-666666666666",
            },
          ],
        };
      }
      return { rows: [] };
    });
    database.connect.mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    });
    mockMovementQueries({ requestedMovementId: COMPENSATION_ID });

    const replay = await repoCompensateMovement(
      ORIGINAL_ID,
      BODY,
      AUDIT,
      "stock-compensation-intent-00042"
    );

    expect(replay?.movement).toMatchObject({
      id: COMPENSATION_ID,
      movement_no: "MVT-COMP-00042",
      status: "DRAFT",
    });
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO public.stock_command_receipts")
      )
    ).toBe(false);
    expect(
      database.query.mock.calls.some(([sql]) =>
        String(sql).includes("WHERE reversal_of_id = $1::uuid")
      )
    ).toBe(false);
  });

  it("rejects the same intention key when the compensation payload changes", async () => {
    const originalRequestHash = hashStockCommand("MOVEMENT_COMPENSATE", {
      movement_id: ORIGINAL_ID,
      ...BODY,
    });
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.stock_command_receipts")) {
        return {
          rows: [
            {
              request_hash: originalRequestHash,
              resource_type: "stock_movement",
              resource_id: COMPENSATION_ID,
              result_payload: {},
              correlation_id: "66666666-6666-4666-8666-666666666666",
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      beginStockCommand(
        { query } as never,
        {
          audit: AUDIT,
          idempotency_key: "stock-compensation-intent-00042",
          command_type: "MOVEMENT_COMPENSATE",
          request_payload: {
            movement_id: ORIGINAL_ID,
            ...BODY,
            reason: "Un autre motif ne doit pas partager la clé",
          },
        }
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});
