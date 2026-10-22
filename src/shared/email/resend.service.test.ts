import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTransactionalEmail } from "./resend.service";

afterEach(() => { vi.unstubAllEnvs();vi.unstubAllGlobals(); });

describe("Test acknowledgement delivery at the provider boundary", () => {
  it("emits only the connected sender address, with a Test subject and archived attachment", async () => {
    vi.stubEnv("CERP_ENVIRONMENT", "test");vi.stubEnv("RESEND_API_KEY", "synthetic-never-transmitted");vi.stubEnv("RESEND_FROM", "fixture@example.test");
    const provider=vi.fn().mockResolvedValue(new Response(JSON.stringify({ id:"synthetic-provider" }),{status:200}));vi.stubGlobal("fetch",provider);
    await sendTransactionalEmail({ to:["customer@example.com"],testSenderEmail:"operator@example.test",subject:"AR-42",text:"Fixture",html:"<p>Fixture</p>",attachments:[{filename:"AR.pdf",content:Buffer.from("synthetic-pdf")}] });
    const sent=JSON.parse(provider.mock.calls[0][1].body);
    expect(sent.to).toEqual(["operator@example.test"]);expect(sent).not.toHaveProperty("cc");expect(sent).not.toHaveProperty("bcc");expect(sent.subject).toMatch(/^\[TEST/);expect(sent.attachments[0].filename).toBe("AR.pdf");
  });
  it("makes no provider request for a missing Test sender", async () => {
    vi.stubEnv("CERP_ENVIRONMENT", "test");vi.stubEnv("RESEND_API_KEY", "synthetic-never-transmitted");vi.stubEnv("RESEND_FROM", "fixture@example.test");
    const provider=vi.fn();vi.stubGlobal("fetch",provider);
    await expect(sendTransactionalEmail({to:["customer@example.com"],testSenderEmail:null,subject:"AR",text:"Fixture",html:"Fixture"})).rejects.toThrow("TEST_EMAIL_SENDER_EMAIL_REQUIRED");
    expect(provider).not.toHaveBeenCalled();
  });
});
