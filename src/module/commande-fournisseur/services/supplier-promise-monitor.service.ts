import { readSupplierPromiseExceptions } from "../repository/supplier-promise-monitor.repository";

export function getSupplierPromiseExceptions(today: string) {
  return readSupplierPromiseExceptions(today);
}
