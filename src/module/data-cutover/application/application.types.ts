import type { PoolClient } from "pg";
import type { CutoverDomain, CutoverIssue, CutoverRow } from "../types/data-cutover.types";

export type ApplicationTarget = { type: string; id: string; reference: string | null; url: string };
export type ApplicationOperation = {
  key: string; kind: string; domain: CutoverDomain; label: string;
  source_row_ids: string[]; source_count: number;
  state: "READY" | "BLOCKED" | "ALREADY_APPLIED";
  mode: "CREATE" | "LINK" | "OPENING" | "ARCHIVE";
  blockers: Array<CutoverIssue & { row_id?: string }>;
  effects: string[]; targets?: ApplicationTarget[];
};
export type ApplicationPreview = {
  batch_id: string; batch_version: number; preview_hash: string;
  can_apply: boolean; posting_available: boolean; generated_at: string;
  external_effects: false;
  summary: { selected_rows: number; ready_operations: number; blocked_operations: number; applied_rows: number };
  operations: ApplicationOperation[];
  blockers: Array<CutoverIssue & { row_id?: string }>;
};
export type ApplicationReceiptOperation = {
  key: string; kind: string; label: string;
  status: "APPLIED" | "ALREADY_APPLIED" | "BLOCKED" | "FAILED";
  targets: ApplicationTarget[];
  failure?: { code: string; message: string };
};
export type ApplicationReceipt = {
  id: string; batch_id: string; status: "APPLIED" | "PARTIAL" | "FAILED";
  created_at: string; applied_by: number; replayed: boolean;
  operations: ApplicationReceiptOperation[]; business_writes: boolean;
  external_effects: false;
};
export type ResolvedApplicationTarget = { id: string; reference: string | null; type: string; planned?: true };
export type ApplicationContext = {
  client: PoolClient; batchId: string; actorId: number; sourceSystem: string;
  correlationId: string; operationKey: string; rows: CutoverRow[];
  targets: Map<string, ResolvedApplicationTarget>;
};
export type AppliedApplicationTarget = {
  rowId: string; domain: CutoverDomain;
  targetType: string; targetId: string; targetReference: string | null;
};
export type ApplicationAdapter = {
  domains: CutoverDomain[];
  kind: string;
  mode: ApplicationOperation["mode"];
  effects: string[];
  /** Preview-only dependency. The apply map contains committed or newly written IDs only. */
  plannedTargetType?: string;
  groupKey(row: CutoverRow, targets?: ReadonlyMap<string, ResolvedApplicationTarget>): string;
  inspect(context: ApplicationContext): Promise<Array<CutoverIssue & { row_id?: string }>>;
  apply(context: ApplicationContext): Promise<{ targets: AppliedApplicationTarget[] }>;
};
