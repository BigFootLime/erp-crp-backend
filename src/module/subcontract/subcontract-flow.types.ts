export type SubcontractReturn = {
  id: string;
  packageId: string;
  operationId: string;
  receiptLineId: string | null;
  receiptNumber: string | null;
  lotId: string;
  lotCode: string;
  quantity: number;
  returnedAt: string;
  released: number;
  transferred: number;
  transferable: number;
  blockers: string[];
};
export type SubcontractFlow = {
  packageId: string;
  operationId: string;
  ofId: number;
  supplierId: string;
  supplierName: string;
  orderId: string;
  orderCode: string;
  orderLineId: string;
  unit: string;
  planned: number;
  issued: number;
  returned: number;
  custody: number;
  released: number;
  transferred: number;
  promisedDate: string | null;
  promiseSource: "LINE" | "ORDER" | "ESTIMATE";
  departedAt: string | null;
  lastReturnAt: string | null;
  status: string;
  version: string;
  returns: SubcontractReturn[];
};

/** A saved purchasing preparation is a forecast, never a physical work package. */
export type ExternalServicePreparation = {
  id: string;
  operationId: string;
  purchaseId: string;
  label: string;
  supplierId: string;
  supplierName: string;
  quantity: number;
  due: string | null;
  leadDays: number | null;
  orderLineIds: string[];
  version: string;
};
