import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../services/facture-workflow.service", () => ({ svcGetFactureWorkflow: mocks.read }));
import { repoGetFactureWorkflow } from "./facture-workflow-read.repository";
import { getFactureWorkflow } from "../controllers/facture-workflow.controller";

const saved = { id: 1, draft_reference: "DFT-TEST", status: "APPROVED", row_version: 3, preview_hash: "saved-hash", total_incl_tax: "480.00", lines: [{ quantity: "4.000" }], due_dates: [] };
beforeEach(() => vi.resetAllMocks());
describe("saved invoice workflow read", () => {
  it.each(["DRAFT", "APPROVED", "ISSUED"])("reads persisted %s without recalculating or writing", async status => {
    const document = { ...saved, status };
    mocks.query.mockResolvedValue({ rows: [document] });
    expect(await repoGetFactureWorkflow(1)).toEqual(document);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1]).toEqual([1]);
    expect(mocks.query.mock.calls[0][0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/i);
  });
  it("returns 404 for an unknown id and never substitutes another invoice", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(repoGetFactureWorkflow(987)).rejects.toMatchObject({ status: 404, code: "FACTURE_NOT_FOUND" });
  });
  it("does not invent an approval hash for legacy invoices", async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...saved, preview_hash: null }] });
    await expect(repoGetFactureWorkflow(1)).rejects.toMatchObject({ status: 409, code: "FACTURE_WORKFLOW_UNAVAILABLE" });
  });
  it("controller requires an authenticated actor before reading", async () => {
    const next = vi.fn();
    await getFactureWorkflow({ params: { id: "1" } } as unknown as Request, {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("controller validates the numeric id before reading", async () => {
    const next = vi.fn();
    await getFactureWorkflow({ params: { id: "garbage" }, user: { id: 7 }, originalUrl: "/factures/workflow/garbage" } as unknown as Request, {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("controller returns the saved document without a command receipt", async () => {
    mocks.read.mockResolvedValue(saved);
    const json = vi.fn(), next = vi.fn();
    await getFactureWorkflow({ params: { id: "1" }, user: { id: 7 }, originalUrl: "/factures/workflow/1" } as unknown as Request, { json } as unknown as Response, next);
    expect(mocks.read).toHaveBeenCalledWith(1); expect(json).toHaveBeenCalledWith(saved); expect(next).not.toHaveBeenCalled();
  });
});
