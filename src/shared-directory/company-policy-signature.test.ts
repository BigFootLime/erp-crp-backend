import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  companyPolicyReplyMac,
  verifyCompanyPolicyReply,
} from "./company-policy-signature";

describe("company policy reply signature", () => {
  it("binds the exact response body and request nonce to the site key", () => {
    const key = randomBytes(32).toString("hex"),
      nonce = randomUUID(),
      body = Buffer.from('{"policy":"fixed"}');
    const signature = companyPolicyReplyMac(key, nonce, body).toString("hex");
    expect(verifyCompanyPolicyReply(key, nonce, body, signature)).toBe(true);
    expect(verifyCompanyPolicyReply(key, randomUUID(), body, signature)).toBe(
      false,
    );
    expect(
      verifyCompanyPolicyReply(
        key,
        nonce,
        Buffer.from('{"policy":"changed"}'),
        signature,
      ),
    ).toBe(false);
    expect(
      verifyCompanyPolicyReply(
        randomBytes(32).toString("hex"),
        nonce,
        body,
        signature,
      ),
    ).toBe(false);
  });
});
