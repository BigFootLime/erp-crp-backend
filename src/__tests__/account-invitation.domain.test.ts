import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashAccountInvitationToken,
  signAccountInvitationToken,
  verifyAccountInvitationToken,
} from "../module/auth/domain/account-invitation";

const previousSecret = process.env.JWT_SECRET;

describe("account invitation token", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "sol-02-invitation-test-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T20:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it("signs a deterministic opaque token and verifies its provisioning boundary", () => {
    const data = {
      invitationId: "11111111-1111-4111-8111-111111111111",
      userId: 42,
      createdAt: "2026-08-09T20:00:00.000Z",
      expiresAt: "2026-08-10T20:00:00.000Z",
    };
    const token = signAccountInvitationToken(data);
    expect(signAccountInvitationToken(data)).toBe(token);
    expect(verifyAccountInvitationToken(token)).toEqual({ invitationId: data.invitationId, userId: 42 });
    expect(hashAccountInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes an expired invitation without accepting it", () => {
    const token = signAccountInvitationToken({
      invitationId: "11111111-1111-4111-8111-111111111111",
      userId: 42,
      createdAt: "2026-08-08T19:00:00.000Z",
      expiresAt: "2026-08-09T19:00:00.000Z",
    });
    expect(() => verifyAccountInvitationToken(token)).toThrowError(expect.objectContaining({
      status: 400,
      code: "INVITATION_EXPIRED",
    }));
  });
});
