import type { AuditContext } from "../repository/stock.repository";
import {
  repoConsumeStockReservation,
  repoCreateStockReservation,
  repoGetStockReservation,
  repoListStockReservations,
  repoReleaseStockReservation,
} from "../repository/stock-reservation.repository";
import type {
  ConsumeStockReservationBodyDTO,
  CreateStockReservationBodyDTO,
  ListStockReservationsQueryDTO,
  StockReservationActionBodyDTO,
} from "../validators/stock-reservation.validators";

export const listStockReservationsSVC = (query: ListStockReservationsQueryDTO) =>
  repoListStockReservations(query);

export const getStockReservationSVC = (id: string) => repoGetStockReservation(id);

export const createStockReservationSVC = (
  body: CreateStockReservationBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
) => repoCreateStockReservation(body, audit, idempotencyKey);

export const releaseStockReservationSVC = (
  id: string,
  body: StockReservationActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
) => repoReleaseStockReservation(id, body, audit, idempotencyKey);

export const consumeStockReservationSVC = (
  id: string,
  body: ConsumeStockReservationBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
) => repoConsumeStockReservation(id, body, audit, idempotencyKey);
