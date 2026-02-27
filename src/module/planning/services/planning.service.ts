import type {
  Paginated,
  PlanningEventComment,
  PlanningEventDetail,
  PlanningEventDocument,
  PlanningEventListItem,
  PlanningResources,
} from "../types/planning.types";
import type {
  CreatePlanningEventBodyDTO,
  CreatePlanningEventCommentBodyDTO,
  AutoPlanPlanningBodyDTO,
  ListPlanningEventsQueryDTO,
  ListPlanningResourcesQueryDTO,
  PatchPlanningEventBodyDTO,
} from "../validators/planning.validators";
import type { AuditContext } from "../repository/planning.repository";
import {
  repoGetActivePlanningEventForOfOperation,
  repoListOfOperationsForAutoplan,
  repoArchivePlanningEvent,
  repoCreatePlanningEvent,
  repoCreatePlanningEventComment,
  repoGetPlanningEventDetail,
  repoGetPlanningEventDocumentFileMeta,
  repoListPlanningEvents,
  repoListPlanningResources,
  repoPatchPlanningEvent,
  repoUploadPlanningEventDocuments,
} from "../repository/planning.repository";

function clampPositiveInt(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
}

function ceilToStepMinutes(tsMs: number, stepMinutes: number): number {
  const stepMs = stepMinutes * 60_000;
  if (stepMs <= 0) return tsMs;
  return Math.ceil(tsMs / stepMs) * stepMs;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function svcListPlanningResources(query: ListPlanningResourcesQueryDTO): Promise<PlanningResources> {
  return repoListPlanningResources(query);
}

export async function svcListPlanningEvents(query: ListPlanningEventsQueryDTO): Promise<Paginated<PlanningEventListItem>> {
  return repoListPlanningEvents(query);
}

export async function svcGetPlanningEventDetail(id: string): Promise<PlanningEventDetail | null> {
  return repoGetPlanningEventDetail(id);
}

export async function svcCreatePlanningEvent(params: {
  body: CreatePlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem> {
  return repoCreatePlanningEvent(params);
}

export async function svcAutoPlanPlanning(params: {
  body: AutoPlanPlanningBodyDTO;
  audit: AuditContext;
}): Promise<{
  created_events: Array<{
    event_id: string;
    of_id: number;
    of_operation_id: string;
    start_ts: string;
    end_ts: string;
  }>;
  skipped_operations: Array<{
    of_id: number;
    of_operation_id: string;
    reason: "ALREADY_PLANNED" | "MISSING_RESOURCE" | "FAILED";
    existing_event_id?: string | null;
    message?: string;
  }>;
}> {
  const stepMinutes = clampPositiveInt(params.body.step_minutes ?? 15, 15);
  const baseStartRaw = params.body.start_ts ? Date.parse(params.body.start_ts) : Date.now();
  const baseStartMs = ceilToStepMinutes(Number.isFinite(baseStartRaw) ? baseStartRaw : Date.now(), stepMinutes);

  const fallbackResource = params.body.fallback_resource ?? null;
  const skipPlanned = params.body.skip_planned !== false;

  const rows = await repoListOfOperationsForAutoplan({
    of_ids: params.body.of_ids,
    include_done: params.body.include_done,
  });

  const byOf = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byOf.get(r.of_id);
    if (list) list.push(r);
    else byOf.set(r.of_id, [r]);
  }

  for (const list of byOf.values()) {
    list.sort((a, b) => a.phase - b.phase || a.of_operation_id.localeCompare(b.of_operation_id));
  }

  const created_events: Array<{
    event_id: string;
    of_id: number;
    of_operation_id: string;
    start_ts: string;
    end_ts: string;
  }> = [];
  const skipped_operations: Array<{
    of_id: number;
    of_operation_id: string;
    reason: "ALREADY_PLANNED" | "MISSING_RESOURCE" | "FAILED";
    existing_event_id?: string | null;
    message?: string;
  }> = [];

  for (const ofId of params.body.of_ids) {
    const ops = byOf.get(ofId) ?? [];
    let cursorMs = baseStartMs;

    for (const op of ops) {
      if (skipPlanned) {
        const existing = await repoGetActivePlanningEventForOfOperation(op.of_operation_id);
        if (existing) {
          const endMs = Date.parse(existing.end_ts);
          if (Number.isFinite(endMs)) cursorMs = Math.max(cursorMs, endMs);
          skipped_operations.push({
            of_id: op.of_id,
            of_operation_id: op.of_operation_id,
            reason: "ALREADY_PLANNED",
            existing_event_id: existing.id,
          });
          continue;
        }
      }

      const durationMinutes = Math.max(15, clampPositiveInt(Math.round(op.temps_total_planned), 15));
      const durationMs = durationMinutes * 60_000;
      let startMs = ceilToStepMinutes(cursorMs, stepMinutes);
      let usedFallback = false;
      let created = false;
      let skipped = false;

      for (let attempt = 0; attempt < 80; attempt++) {
        const endMs = startMs + durationMs;
        try {
          const out = await repoCreatePlanningEvent({
            body: {
              kind: "OF_OPERATION",
              status: "PLANNED",
              priority: op.of_priority ?? "NORMAL",
              of_id: op.of_id,
              of_operation_id: op.of_operation_id,
              machine_id:
                usedFallback && fallbackResource?.resource_type === "MACHINE" ? fallbackResource.resource_id : null,
              poste_id: usedFallback && fallbackResource?.resource_type === "POSTE" ? fallbackResource.resource_id : null,
              title: undefined,
              description: null,
              start_ts: toIso(startMs),
              end_ts: toIso(endMs),
              allow_overlap: false,
            },
            audit: params.audit,
          });

          created_events.push({
            event_id: out.id,
            of_id: op.of_id,
            of_operation_id: op.of_operation_id,
            start_ts: out.start_ts,
            end_ts: out.end_ts,
          });

          const createdEnd = Date.parse(out.end_ts);
          cursorMs = Number.isFinite(createdEnd) ? createdEnd : endMs;
          created = true;
          break;
        } catch (err) {
          const httpErr = err as { code?: unknown; details?: unknown; message?: unknown };

          if (httpErr && httpErr.code === "MISSING_RESOURCE") {
            if (fallbackResource && !usedFallback) {
              usedFallback = true;
              continue;
            }
            skipped_operations.push({
              of_id: op.of_id,
              of_operation_id: op.of_operation_id,
              reason: "MISSING_RESOURCE",
              message: typeof httpErr.message === "string" ? httpErr.message : undefined,
            });
            skipped = true;
            break;
          }

          if (httpErr && httpErr.code === "PLANNING_CONFLICT") {
            const d = httpErr.details as { conflicts?: unknown } | null;
            const rawConflicts = d && typeof d === "object" ? d.conflicts : null;
            if (Array.isArray(rawConflicts) && rawConflicts.length) {
              let maxEnd = startMs;
              for (const c of rawConflicts) {
                if (!c || typeof c !== "object") continue;
                const endTs = (c as { end_ts?: unknown }).end_ts;
                if (typeof endTs !== "string") continue;
                const t = Date.parse(endTs);
                if (Number.isFinite(t)) maxEnd = Math.max(maxEnd, t);
              }
              startMs = ceilToStepMinutes(maxEnd, stepMinutes);
            } else {
              startMs = ceilToStepMinutes(startMs + stepMinutes * 60_000, stepMinutes);
            }
            continue;
          }

          skipped_operations.push({
            of_id: op.of_id,
            of_operation_id: op.of_operation_id,
            reason: "FAILED",
            message: err instanceof Error ? err.message : "Unexpected error",
          });
          skipped = true;
          break;
        }
      }

      if (!created && !skipped) {
        skipped_operations.push({
          of_id: op.of_id,
          of_operation_id: op.of_operation_id,
          reason: "FAILED",
          message: "Too many conflicts; try a different start time or resource availability.",
        });
      }
    }
  }

  return { created_events, skipped_operations };
}

export async function svcPatchPlanningEvent(params: {
  id: string;
  patch: PatchPlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem | null> {
  return repoPatchPlanningEvent(params);
}

export async function svcArchivePlanningEvent(params: { id: string; audit: AuditContext }): Promise<boolean | null> {
  return repoArchivePlanningEvent(params);
}

export async function svcCreatePlanningEventComment(params: {
  event_id: string;
  body: CreatePlanningEventCommentBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventComment> {
  return repoCreatePlanningEventComment(params);
}

export async function svcUploadPlanningEventDocuments(params: {
  event_id: string;
  documents: { originalname: string; path: string; mimetype: string; size?: number }[];
  audit: AuditContext;
}): Promise<PlanningEventDocument[]> {
  return repoUploadPlanningEventDocuments(params);
}

export async function svcGetPlanningEventDocumentFileMeta(params: {
  event_id: string;
  document_id: string;
}) {
  return repoGetPlanningEventDocumentFileMeta(params);
}
