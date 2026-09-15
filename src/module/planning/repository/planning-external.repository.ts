import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import {
  readSubcontractFlows,
  readExternalTransfers,
  subcontractFlowInstalled,
} from "../../subcontract/subcontract-flow.repository";
import type {
  CentralTask,
  Dependency,
  Resource,
} from "../types/planning-central.types";
import { expandCalendar } from "../domain/central-calendar";
import { externalCompletion } from "../domain/external-schedule";

export async function hydrateExternalPlanning(
  tx: Pick<PoolClient, "query">,
  tasks: CentralTask[],
  resources: Resource[],
  dependencies: Dependency[],
  from: string,
  to: string,
) {
  const external = tasks.filter((t) => t.view === "external" && t.operationId);
  if (!external.length) return;
  if (!(await subcontractFlowInstalled(tx))) {
    for (const task of external) {
      task.blockers.push("Raccordement sous-traitance à installer.");
      task.earliestStart = null;
    }
    return;
  }
  const flows = await readSubcontractFlows(
    tx,
    external.map((t) => t.operationId!),
  );
  const suppliers = [...new Set(flows.map((p) => p.supplierId))];
  const calendars = (
    await tx.query(
      `SELECT f.id::text AS supplier_id,COALESCE(f.nom,f.raison_sociale) AS name,c.*,
    COALESCE((SELECT json_agg(json_build_object('start',start_date::text,'end',end_date::text)) FROM public.programmation_calendar_closures WHERE calendar_id=c.id),'[]') AS closed_dates
    FROM public.fournisseurs f LEFT JOIN public.subcontract_supplier_calendars sc ON sc.supplier_id=f.id
    LEFT JOIN public.programmation_calendars c ON c.id=COALESCE(sc.calendar_id,(SELECT id FROM public.programmation_calendars WHERE active
      AND(SELECT count(*) FROM public.programmation_calendars WHERE active)=1)) AND c.active WHERE f.id=ANY($1::uuid[])`,
      [suppliers],
    )
  ).rows;
  for (const supplierId of suppliers) {
    const row = calendars.find((c) => c.supplier_id === supplierId);
    if (!row) continue;
    const hours = (v: string) => {
      const [h, m] = v.split(":").map(Number);
      return h * 60 + m;
    };
    const closedDates: string[] = [];
    for (const c of row.closed_dates)
      for (
        let day = Date.parse(c.start);
        day <= Date.parse(c.end);
        day += 86400000
      )
        closedDates.push(new Date(day).toISOString().slice(0, 10));
    const shifts = (row.working_days ?? []).map((day: number) => ({
      weekday: day % 7,
      startMinute: hours(row.day_start),
      endMinute: hours(row.day_end),
    }));
    const departed = flows
      .filter((p) => p.supplierId === supplierId && p.departedAt)
      .map((p) => p.departedAt!)
      .sort()[0];
    const start = new Date(
      Math.max(
        Date.parse(to) - 366 * 86400000,
        Math.min(
          Date.parse(from),
          departed ? Date.parse(departed) : Date.parse(from),
        ),
      ),
    ).toISOString();
    resources.push({
      id: "supplier:" + supplierId,
      kind: "SUPPLIER",
      label: row.name,
      timezone: row.timezone ?? "Europe/Paris",
      version: JSON.stringify(row),
      availability: shifts.length
        ? expandCalendar(
            { timezone: row.timezone, shifts, closures: [], closedDates },
            start,
            to,
          )
        : [],
    });
  }
  const transfers = await readExternalTransfers(tx, flows);
  for (const task of external) {
    const packages = flows.filter((p) => p.operationId === task.operationId);
    task.resourceIds = [
      ...new Set(packages.map((p) => "supplier:" + p.supplierId)),
    ];
    task.eligibleResourceIds = task.resourceIds;
    const projection = externalCompletion(
      packages,
      task.quantity,
      task.committed?.start ?? from,
      resources,
      new Date().toISOString(),
    );
    const ready = transfers
      .filter((b) => b.operation_id === task.operationId)
      .reduce((n, b) => n + b.effective, 0);
    const firstTransfer = transfers
      .filter((b) => b.operation_id === task.operationId && b.effective > 0)
      .map((b) => new Date(b.created_at).toISOString())
      .sort()[0];
    task.external = {
      packages,
      ...projection,
      firstBatchReadyAt: firstTransfer ?? null,
    };
    task.good = packages.reduce((n, p) => n + p.released, 0);
    task.released = ready;
    const departed = packages
      .flatMap((p) => (p.departedAt ? [p.departedAt] : []))
      .sort()[0];
    if (departed) {
      task.actual = { ...task.actual, start: departed };
      if (task.commitment !== "DONE") task.commitment = "STARTED";
    }
    task.version = createHash("sha256")
      .update(task.version + JSON.stringify(packages))
      .digest("hex");
    for (const edge of dependencies.filter((d) => d.predecessorId === task.id))
      edge.releasedQuantity = transfers
        .filter(
          (b) =>
            "op:" + b.operation_id === edge.predecessorId &&
            "op:" + b.successor_operation_id === edge.successorId,
        )
        .reduce((n, b) => n + b.effective, 0);
  }
}
