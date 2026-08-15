import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPortalOpaqueValue,
  normalizePortalEmail,
  signPortalInvitationToken,
  signPortalSession,
  verifyPortalInvitationToken,
  verifyPortalSession,
} from "./client-portal-security";

const previousSecret = process.env.CLIENT_PORTAL_JWT_SECRET;

describe("client portal security boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:30:00.000Z"));
    process.env.CLIENT_PORTAL_JWT_SECRET = "sol29-test-secret-with-at-least-32-characters";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousSecret === undefined) delete process.env.CLIENT_PORTAL_JWT_SECRET;
    else process.env.CLIENT_PORTAL_JWT_SECRET = previousSecret;
  });

  it("normalizes an email without changing the stored display value", () => {
    expect(normalizePortalEmail("  CONTACT.Client@Example.COM ")).toBe("contact.client@example.com");
  });

  it("signs a portal session with a dedicated audience and tenant claims", () => {
    const token = signPortalSession({
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      clientId: "042",
      sessionEpoch: 7,
    });
    expect(verifyPortalSession(token)).toEqual({
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      clientId: "042",
      sessionEpoch: 7,
    });
  });

  it("rejects an ERP token signed with another secret", () => {
    process.env.CLIENT_PORTAL_JWT_SECRET = "sol29-other-secret-with-at-least-32-characters";
    const token = signPortalSession({
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      clientId: "042",
      sessionEpoch: 1,
    });
    process.env.CLIENT_PORTAL_JWT_SECRET = "sol29-test-secret-with-at-least-32-characters";
    expect(() => verifyPortalSession(token)).toThrowError(/Session portail invalide/);
  });

  it("keeps invitation tokens deterministic and only stores a SHA-256 fingerprint", () => {
    const data = {
      tokenId: "1e13fe9c-58ca-4e04-8388-d617f59095d6",
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      createdAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-15T12:00:00.000Z",
    };
    const first = signPortalInvitationToken(data);
    const second = signPortalInvitationToken(data);
    expect(first).toBe(second);
    expect(hashPortalOpaqueValue(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPortalInvitationToken(first)).toEqual({ tokenId: data.tokenId, accountId: data.accountId });
  });

  it("rejects an expired invitation without revealing the account", () => {
    const token = signPortalInvitationToken({
      tokenId: "1e13fe9c-58ca-4e04-8388-d617f59095d6",
      accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
      createdAt: "2025-08-14T12:00:00.000Z",
      expiresAt: "2025-08-15T12:00:00.000Z",
    });
    expect(() => verifyPortalInvitationToken(token)).toThrowError(/Lien portail expiré/);
  });
});
