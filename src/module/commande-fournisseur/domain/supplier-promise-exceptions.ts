export type SupplierPromiseSource = "LINE" | "ORDER" | "MISSING";
export type SupplierPromiseInput = {
  id: string;
  orderCode: string;
  supplierName: string;
  status: string;
  promisedDate: string | null;
  needDate: string | null;
  ordered: number;
  received: number;
  isSubcontract: boolean;
  ofId: number | null;
  customerOrderId: number | null;
};

export type SupplierPromiseException = SupplierPromiseInput & {
  code:
    | "MISSING_ACKNOWLEDGEMENT"
    | "PROMISE_MISSING"
    | "PROMISE_LATE"
    | "PROMISE_OVERDUE";
  severity: "P0" | "P1" | "P2";
  promiseSource: SupplierPromiseSource;
  remaining: number;
  impacts: Array<"SUBCONTRACT" | "WORK_ORDER" | "CUSTOMER_ORDER">;
};

/** A supplier date remains evidence, never a receipt. The monitor is read-only. */
export function classifySupplierPromiseExceptions(
  rows: readonly SupplierPromiseInput[],
  today: string,
): SupplierPromiseException[] {
  return rows
    .flatMap((row) => {
      const remaining = Math.max(0, row.ordered - row.received);
      if (
        remaining <= 0 ||
        ["ANNULEE", "CLOTUREE", "RECUE"].includes(row.status)
      )
        return [];
      const impacts: SupplierPromiseException["impacts"] = [];
      if (row.isSubcontract) impacts.push("SUBCONTRACT");
      if (row.ofId !== null) impacts.push("WORK_ORDER");
      if (row.customerOrderId !== null) impacts.push("CUSTOMER_ORDER");
      const promiseSource: SupplierPromiseSource = row.promisedDate
        ? "LINE"
        : "MISSING";
      let code: SupplierPromiseException["code"] | null = null;
      let severity: SupplierPromiseException["severity"] = "P2";
      if (row.status === "ENVOYEE" && !row.promisedDate) {
        code = "MISSING_ACKNOWLEDGEMENT";
        severity = "P1";
      } else if (!row.promisedDate) {
        code = "PROMISE_MISSING";
        severity = "P1";
      } else if (row.promisedDate < today) {
        code = "PROMISE_OVERDUE";
        severity = "P0";
      } else if (row.needDate && row.promisedDate > row.needDate) {
        code = "PROMISE_LATE";
        severity = "P1";
      }
      return code
        ? [{ ...row, code, severity, promiseSource, remaining, impacts }]
        : [];
    })
    .sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        (left.promisedDate ?? "9999-12-31").localeCompare(
          right.promisedDate ?? "9999-12-31",
        ) ||
        left.id.localeCompare(right.id),
    );
}
