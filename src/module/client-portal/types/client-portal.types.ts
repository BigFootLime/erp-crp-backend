export const CLIENT_PORTAL_ACCOUNT_STATUSES = [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;

export type ClientPortalAccountStatus = (typeof CLIENT_PORTAL_ACCOUNT_STATUSES)[number];

export type ClientPortalIdentity = Readonly<{
  accountId: string;
  clientId: string;
  sessionEpoch: number;
}>;

export type ClientPortalDocumentState =
  | "AVAILABLE"
  | "PENDING_SCAN"
  | "QUARANTINED"
  | "EXPIRED"
  | "REPLACED"
  | "UNAVAILABLE"
  | "REVOKED";

export type ClientPortalAuditActor =
  | Readonly<{ kind: "ERP_USER"; id: number }>
  | Readonly<{ kind: "PORTAL_ACCOUNT"; id: string }>
  | Readonly<{ kind: "SYSTEM" }>;

export type ClientPortalRequestMeta = Readonly<{
  requestId: string | null;
  ipHash: string | null;
  userAgentFamily: string | null;
}>;

declare global {
  namespace Express {
    interface Request {
      portalIdentity?: ClientPortalIdentity;
    }
  }
}

