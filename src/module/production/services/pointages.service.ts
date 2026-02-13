import { HttpError } from "../../../utils/httpError";

import type { AuditContext } from "../repository/production.repository";
import type {
  CreatePointageManualBodyDTO,
  ListOperatorsQueryDTO,
  ListPointagesQueryDTO,
  PatchPointageBodyDTO,
  PointagesKpisQueryDTO,
  StartPointageBodyDTO,
  StopPointageBodyDTO,
  ValidatePointageBodyDTO,
} from "../validators/pointages.validators";
import type {
  PointageUserLite,
  ProductionPointageDetail,
  ProductionPointageListItem,
  ProductionPointagesKpis,
} from "../types/pointages.types";
import type { Paginated } from "../types/production.types";
import {
  repoCreatePointageManual,
  repoGetPointage,
  repoListOperators,
  repoListPointages,
  repoPatchPointage,
  repoPointagesKpis,
  repoStartPointage,
  repoStopPointage,
  repoValidatePointage,
} from "../repository/pointages.repository";

function parseTs(value: string, label: string): number {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    throw new HttpError(400, "INVALID_DATETIME", `Invalid ${label}`);
  }
  return t;
}

function assertStartEndOrder(startTs: string, endTs: string) {
  const s = parseTs(startTs, "start_ts");
  const e = parseTs(endTs, "end_ts");
  if (e <= s) {
    throw new HttpError(400, "INVALID_TIME_RANGE", "end_ts must be after start_ts");
  }
}

export async function svcListPointages(query: ListPointagesQueryDTO): Promise<Paginated<ProductionPointageListItem>> {
  return repoListPointages(query);
}

export async function svcGetPointage(id: string): Promise<ProductionPointageDetail | null> {
  return repoGetPointage(id);
}

export async function svcCreatePointageManual(params: {
  body: CreatePointageManualBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail> {
  assertStartEndOrder(params.body.start_ts, params.body.end_ts);
  return repoCreatePointageManual(params);
}

export async function svcStartPointage(params: {
  id: string;
  body: StartPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail> {
  return repoStartPointage(params);
}

export async function svcStopPointage(params: {
  id: string;
  body: StopPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  return repoStopPointage(params);
}

export async function svcPatchPointage(params: {
  id: string;
  body: PatchPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  const p = params.body.patch;
  if (typeof p.start_ts === "string" && typeof p.end_ts === "string") {
    assertStartEndOrder(p.start_ts, p.end_ts);
  }
  return repoPatchPointage(params);
}

export async function svcValidatePointage(params: {
  id: string;
  body: ValidatePointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  return repoValidatePointage(params);
}

export async function svcPointagesKpis(query: PointagesKpisQueryDTO): Promise<ProductionPointagesKpis> {
  return repoPointagesKpis(query);
}

export async function svcListOperators(query: ListOperatorsQueryDTO): Promise<PointageUserLite[]> {
  return repoListOperators(query);
}
