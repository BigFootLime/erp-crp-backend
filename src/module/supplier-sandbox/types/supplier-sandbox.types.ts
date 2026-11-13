export type SupplierSandboxIdentity = Readonly<{
  accountId: string;
  supplierId: string;
  sessionEpoch: number;
}>;
declare global {
  namespace Express {
    interface Request {
      supplierSandboxIdentity?: SupplierSandboxIdentity;
    }
  }
}
