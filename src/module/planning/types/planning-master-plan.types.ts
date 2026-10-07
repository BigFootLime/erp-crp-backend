import type { Interval } from './planning-central.types';

export type MasterPlanPeriod = Interval & { label: string };
export type MasterPlanOrderSource = {
  id: number; number: string; pieceId: string; reference: string;
  indice: string | null; version: number | null; quantity: number;
  good: number | null; due: string | null; status: string; taskIds: string[]; operationCount: number; forecastIssues: string[];
};
export type MasterPlanOrder = MasterPlanOrderSource & {
  period: number | null; committedEnd: string | null; forecastEnd: string | null;
  unplaced: number; missingDuration: number; readiness: 'READY' | 'MISSING';
  issues: string[];
};
export type MasterPlanCapacityCell = {
  capacityMinutes: number | null; committedMinutes: number | null;
  forecastMinutes: number | null; ratio: number | null;
  taskIds: string[]; ofIds: number[]; issues: string[];
};
export type MasterPlanCapacity = {
  id: string; label: string; kind: 'MACHINE' | 'POSTE' | 'PERSON';
  cells: MasterPlanCapacityCell[]; issues: string[];
};
export type MasterPlan = {
  apiVersion: 1; readOnly: true; scope: 'ACTIVE_PRODUCER_OFS';
  revision: string; generatedAt: string; timezone: 'Europe/Paris';
  from: string; to: string; periods: MasterPlanPeriod[];
  orders: MasterPlanOrder[]; capacities: MasterPlanCapacity[];
  summary: {
    activeOrders: number; undatedOrders: number; unplacedOperations: number;
    unassignedOperations: number; missingDuration: number;
    unknownCalendars: number; overdueOrders: number;
    unallocatedForecasts: number;
  };
  warnings: string[];
  forecastCalculatedAt: string | null;
};
