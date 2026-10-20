import { describe, expect, it, vi } from "vitest";
import { cutoverReferenceAdapters } from "./references.adapter";
import type { ApplicationContext } from "../application.types";
import type { CutoverRow } from "../../types/data-cutover.types";

const adapter = (domain: CutoverRow["domain"]) => cutoverReferenceAdapters.find((item) => item.domains[0] === domain)!;
const row = (domain: CutoverRow["domain"], values: CutoverRow["values"]): CutoverRow => ({ id: `${domain}-1`, batch_id: "b", domain, legacy_key: "legacy", source_id: "s", sheet: "r", row_number: 1, source_values: values, values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "ok", version: 1, status: "READY", issues: [] });
const context = (rows: CutoverRow[], targets = new Map()): ApplicationContext => ({ client: {} as ApplicationContext["client"], batchId: "b", actorId: 1, sourceSystem: "CLIPPER", correlationId: "c", operationKey: "o", rows, targets });

describe("cutover reference adapter", () => {
  it("publishes typed planned target adapters", () => {
    expect(cutoverReferenceAdapters.map((item) => item.plannedTargetType)).toEqual(["CUSTOMER", "SUPPLIER", "TECHNICAL_PIECE", "ARTICLE"]);
  });
  it("requires native mandatory customer fields rather than inventing an address or a date", async () => {
    const issue = await adapter("CUSTOMER").inspect(context([row("CUSTOMER", { resolution: "CREATE", customerCode: "001", name: "Client incomplet" })]));
    expect(issue[0]?.code).toBe("CUTOVER_REFERENCE_REQUIRED");
  });
  it("rejects an unconfirmed link and accepts a selected target from context", async () => {
    const unconfirmed = row("CUSTOMER", { resolution: "LINK", targetId: "001", customerCode: "OLD-1" });
    expect((await adapter("CUSTOMER").inspect(context([unconfirmed])))[0]?.code).toBe("CUTOVER_REFERENCE_LINK_REQUIRED");
    const customer = row("CUSTOMER", { resolution: "LINK", targetId: "001", customerCode: "OLD-1" });
    await expect(adapter("CUSTOMER").inspect(context([customer], new Map([["CUSTOMER:001", { id: "001", reference: "C001", type: "CUSTOMER" }]])))).resolves.toEqual([]);
  });
  it("requires an explicit delivery decision and accepts a planned technical dependency at preview", async () => {
    const client = row("CUSTOMER", { resolution: "CREATE", customerCode: "OLD", name: "Client", address: "1 rue", postalCode: "69000", city: "Lyon", country: "FR", creationDate: "2026-10-20" });
    expect((await adapter("CUSTOMER").inspect(context([client])))[0]?.code).toBe("CUTOVER_REFERENCE_BOOLEAN_REQUIRED");
    const article = row("ARTICLE", { resolution: "CREATE", articleReference: "ART", designation: "Piece", category: "fabrique", familyCode: "FAM", unit: "U", lotTracked: false, technicalPieceLegacyKey: "PT-1", commercialScope: "CRP" });
    const targets = new Map([["TECHNICAL_PIECE:PT-1", { id: "11111111-1111-4111-8111-111111111111", reference: "PT", type: "TECHNICAL_PIECE", planned: true }]]);
    const fixture = context([article], targets);
    fixture.client = { query: vi.fn().mockResolvedValue({ rows: [{}] }) } as unknown as ApplicationContext["client"];
    await expect(adapter("ARTICLE").inspect(fixture)).resolves.toEqual([]);
    fixture.client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as ApplicationContext["client"];
    expect((await adapter("ARTICLE").inspect(fixture))[0]?.code).toBe("CUTOVER_ARTICLE_FAMILY_UNCONFIRMED");
  });
});

