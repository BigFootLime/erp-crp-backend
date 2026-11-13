export type SupplierPortalIdentity = Readonly<{ accountId: string; supplierId: string; sessionEpoch: number }>;
declare global { namespace Express { interface Request { supplierPortalIdentity?: SupplierPortalIdentity; } } }
