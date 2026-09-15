import type { readMaterialTx } from '../../production/repository/of-material.repository';
import type { MaterialReservationAvailability } from '../../production/repository/material-reservation-availability.repository';
import { quantity } from '../../production/domain/of-material';
import type { Allocation, CentralTask, CoverageSource, Demand } from '../types/planning-central.types';
import { materialForecastAvailability } from './material-forecast';

export type PlanningCoverage = {coverageAvailable: boolean; sources: CoverageSource[]; demands: Demand[]; allocations: Allocation[]};
export const emptyPlanningCoverage = (): PlanningCoverage => ({coverageAvailable: false, sources: [], demands: [], allocations: []});
const confirmed = (status: string) => ['ENVOYEE', 'ACCUSE_RECU', 'PARTIELLEMENT_RECUE', 'RECUE', 'CLOTUREE'].includes(status);
const unit = (value: string | null | undefined) => value?.trim().toLocaleUpperCase('fr-FR');
const remainder = (a: number, b: number) => quantity(Math.max(0, Number(a) - Number(b)));

/** Read-only evidence from the owning material module. No proposed free quantity
 * becomes an allocation. Each receipt leaves the future slice immediately; its
 * transferred part is represented only by the canonical stock reservation. */
export function projectMaterialCoverage(material: Awaited<ReturnType<typeof readMaterialTx>>, tasks: CentralTask[], reservations: MaterialReservationAvailability, now: string): PlanningCoverage {
  const sources = new Map<string, CoverageSource>(), demands: Demand[] = [], allocations: Allocation[] = [];
  for (const need of material.needs) {
    const id = `material:${material.ofId}:${need.id ?? need.key}`;
    const relevant = tasks.filter(t => t.ofId === material.ofId && t.operationId === need.operationId);
    const due = relevant.flatMap(t => t.committed?.start ? [t.committed.start] : t.forecast?.start ? [t.forecast.start] : []).sort()[0] ?? null;
    const available = reservations.get(need.key) ?? {usable: 0, reservations: new Map<string, number>(), blockers: ['Disponibilité des réservations inconnue.']};
    const issues = [...need.blockers, ...available.blockers];
    if (material.previousNeeds.length) issues.push('Rapprocher les besoins conservés de la précédente définition de l’OF.');
    const sourceIds: string[] = [], promises: Array<{quantity: number; date: string | null}> = [];
    let expected = 0, draft = 0, receivedBlocked = 0, securedExpected = 0;
    const add = (source: CoverageSource, assigned = true) => {
      if (source.quantity <= 0) return;
      const previous = sources.get(source.id);
      // The same free pool may be visible to several needs. It is not multiplied.
      if (!previous || previous.quantity < source.quantity) sources.set(source.id, source);
      sourceIds.push(source.id);
      if (assigned) allocations.push({id: `allocation:${source.id}`, demandId: id, sourceId: source.id, quantity: source.quantity, transferredQuantity: 0, cancelled: false});
    };
    const base = {articleId: need.articleId ?? '', revision: null, unit: need.unit ?? '', contractId: null, ownerClientId: need.requirements.ownerClientId, version: material.version};
    for (const r of need.reservations) {
      if (r.status !== 'ACTIVE' || !r.unexpired) continue;
      const held = remainder(r.qty_reserved, r.qty_consumed), usable = available.reservations.get(String(r.id)) ?? 0;
      add({...base, id: `reservation:${r.id}`, kind: 'PHYSICAL', scope: 'ASSIGNED', state: usable >= held ? 'PHYSICAL' : 'BLOCKED',
        label: r.lot_code ?? 'Lot réservé', referenceId: String(r.id), quantity: held, usable: usable >= held, availableAt: usable >= held ? now : null});
    }
    for (const p of need.promises) {
      if (p.statut === 'ANNULEE') continue;
      const remaining = remainder(p.assigned, p.received), waiting = remainder(p.received, p.transferred), firm = confirmed(p.statut);
      const compatible = need.supplyMode === 'PURCHASE' && p.article_id === need.articleId && unit(p.unite) === unit(need.unit) && !!need.unit
        && (p.owner_client_id ?? null) === need.requirements.ownerClientId && (p.destination_id ?? null) === need.destinationId
        && (unit(p.purchase_unit) === unit(p.unite) || Number.isFinite(Number(p.coefficient)) && Number(p.coefficient) > 0 && Number(p.coefficient) !== 1);
      if (!compatible) issues.push(`Vérifier l’article, l’unité, le propriétaire et la destination de ${p.code}.`);
      expected += firm ? remaining : 0; draft += firm ? 0 : remaining; receivedBlocked += waiting;
      if (firm && compatible) { securedExpected += remaining; promises.push({quantity: remaining, date: p.due}); }
      const purchase = {...base, referenceId: String(p.command_id), lineId: String(p.line_id), label: String(p.code)};
      add({...purchase, id: `purchase:${p.id}:future`, kind: firm ? 'PURCHASE' : 'FORECAST', scope: 'ASSIGNED', state: firm ? 'EXPECTED' : 'DRAFT', quantity: remaining, usable: firm && compatible, availableAt: p.due ?? null});
      add({...purchase, id: `purchase:${p.id}:received`, kind: 'PHYSICAL', scope: 'ASSIGNED', state: 'BLOCKED', quantity: waiting, usable: false, availableAt: null});
    }
    for (const call of material.customerCalls.filter(c => c.need_id === need.id && c.status !== 'CANCELLED')) {
      const remaining = remainder(call.quantity, call.received), waiting = remainder(call.received, call.transferred), firm = call.status === 'ANNOUNCED';
      const compatible = need.supplyMode === 'CUSTOMER' && call.client_id === need.requirements.ownerClientId && unit(call.unit) === unit(need.unit);
      if (!compatible) issues.push('Vérifier le propriétaire et l’unité de la matière annoncée par le client.');
      expected += firm ? remaining : 0; draft += firm ? 0 : remaining; receivedBlocked += waiting;
      if (firm && compatible) { securedExpected += remaining; promises.push({quantity: remaining, date: call.announced_date}); }
      add({...base, id: `customer:${call.id}:future`, kind: 'FORECAST', scope: 'ASSIGNED', state: firm ? 'EXPECTED' : 'DRAFT', label: 'Matière fournie par le client', referenceId: call.id, quantity: remaining, usable: firm && compatible, availableAt: call.announced_date});
      add({...base, id: `customer:${call.id}:received`, kind: 'PHYSICAL', scope: 'ASSIGNED', state: 'BLOCKED', label: 'Réception client à libérer / affecter', referenceId: call.id, quantity: waiting, usable: false, availableAt: null});
    }
    // Canonical proposals already deduct all persisted reservations, including
    // hidden OFs, then share batch/stock-level/quality ceilings inside this OF.
    for (const selection of need.selections) {
      const candidate = need.candidates.find(c => c.lot.batchId === selection.batchId)!;
      add({...base, id: `stock:${selection.batchId}:free`, kind: 'PHYSICAL', scope: 'FREE', state: 'PHYSICAL', label: candidate.lot.code,
        referenceId: selection.lotId, quantity: selection.quantity, usable: true, availableAt: now}, false);
    }
    for (const supply of need.futureSupplies) {
      if (supply.reasons.length) continue;
      const firm = confirmed(supply.status);
      add({...base, id: `purchase-line:${supply.id}:free`, kind: firm ? 'PURCHASE' : 'FORECAST', scope: 'FREE', state: firm ? 'EXPECTED' : 'DRAFT', label: supply.code,
        referenceId: supply.commandId, lineId: supply.id, quantity: supply.available, usable: firm, availableAt: supply.due}, false);
    }
    const supply = materialForecastAvailability({now, required: need.required, consumed: need.consumed, reserved: available.usable,
      blocked: receivedBlocked + remainder(need.reserved, available.usable), preparation: issues, promises});
    if (supply.reason) issues.push(supply.reason);
    if (due && supply.date && supply.date > due) issues.push('Approvisionnement disponible après le démarrage engagé ou prévu.');
    demands.push({id, articleId: base.articleId, compatibleRevisions: [null], unit: base.unit, contractId: null, quantity: need.required, due,
      coverage: {ofId: material.ofId, operationId: need.operationId, sourceRef: need.key, label: need.designation, kind: 'MATERIAL',
        consumed: need.consumed, reserved: need.reserved, usableReserved: available.usable, reservedBlocked: remainder(need.reserved, available.usable),
        stockAvailable: quantity(need.selections.reduce((s, c) => s + c.quantity, 0)), expected: quantity(expected), draft: quantity(draft), receivedBlocked: quantity(receivedBlocked),
        missing: need.missing, toPrepare: need.purchaseMissing, unsecured: remainder(need.required, need.consumed + available.usable + securedExpected),
        availableAt: supply.date, issues: [...new Set(issues)], sourceIds}});
  }
  return {coverageAvailable: true, sources: [...sources.values()], demands, allocations};
}
