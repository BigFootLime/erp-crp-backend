import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), profile: vi.fn(), replay: vi.fn(), lock: vi.fn(), owner: vi.fn(), contact: vi.fn(),
  create: vi.fn(), read: vi.fn(), change: vi.fn(), save: vi.fn(), event: vi.fn(), audit: vi.fn(), realtime: vi.fn() }));
vi.mock("../config/database", () => ({ default: { connect: vi.fn(async () => ({})) } }));
vi.mock("../shared/realtime/realtime-outbox-transaction", () => ({ withRealtimeOutboxTransaction: vi.fn(async (tx, run) => run(tx)) }));
vi.mock("../shared/realtime/realtime-outbox.service", () => ({ enqueueEntityChanged: mocks.realtime }));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../module/client/repository/client-crm.repository", () => ({
  readCrmClient: mocks.client, readCrmProfile: mocks.profile, readCrmReplay: mocks.replay, lockCrmIdempotency: mocks.lock,
  activeCrmOwner: mocks.owner, activeCrmContact: mocks.contact, createCrmFollowup: mocks.create, readCrmFollowup: mocks.read,
  changeCrmFollowup: mocks.change, saveCrmProfile: mocks.save, appendCrmEvent: mocks.event,
}));
import { executeCrmCommand } from "../module/client/services/client-crm.service";
import { crmCommandSchema } from "../module/client/validators/client-crm.validators";
import { emptyCrmProfile } from "../module/client/types/client-crm.types";
import type { AuditContext } from "../module/client/repository/client.repository";
const audit: AuditContext = { user_id: 11, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/clients/001/crm/commands", page_key: "clients.crm", client_session_id: null };
const key = "2649701f-9e95-4b57-9faf-0c21e90ea66d";
const plan = () => crmCommandSchema.parse({ action: "PLAN", expected_profile_version: 0, owner_user_id: 11, contact_id: null,
  channel: "PHONE", purpose: "INITIAL_CONTACT", title: null, due_at: new Date(Date.now() + 86400000).toISOString() });
describe("CRM command boundaries and durable replay", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.client.mockResolvedValue({ client_id: "001", status: "prospect", blocked: false, archived_at: null });
    mocks.profile.mockResolvedValue(emptyCrmProfile("001")); mocks.replay.mockResolvedValue(null);
    mocks.owner.mockResolvedValue(true); mocks.contact.mockResolvedValue(true);
    mocks.create.mockImplementation(async (_tx, clientId, _actor, input) => ({ id: key, client_id: clientId, version: 1, ...input }));
  });
  it("replays the same committed plan without a second reminder, audit or realtime event", async () => {
    const body = plan(); const first = await executeCrmCommand("001", body, key, audit);
    const saved = mocks.event.mock.calls[0][1];
    mocks.replay.mockResolvedValue({ request_hash: saved.hash, response_json: first.result });
    expect(await executeCrmCommand("001", body, key, audit)).toEqual({ result: first.result, replayed: true });
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.audit).toHaveBeenCalledTimes(1); expect(mocks.realtime).toHaveBeenCalledTimes(1);
    await expect(executeCrmCommand("001", { ...body, title: "Une autre demande" }, key, audit)).rejects.toMatchObject({ code: "CRM_IDEMPOTENCY_CONFLICT" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("rejects stale qualification, inactive clients and unavailable responsible users before insertion", async () => {
    mocks.profile.mockResolvedValue({ ...emptyCrmProfile("001"), version: 2 });
    await expect(executeCrmCommand("001", plan(), key, audit)).rejects.toMatchObject({ code: "CRM_VERSION_CONFLICT" });
    mocks.profile.mockResolvedValue(emptyCrmProfile("001")); mocks.client.mockResolvedValue({ client_id: "001", status: "inactif", blocked: false, archived_at: null });
    await expect(executeCrmCommand("001", plan(), key, audit)).rejects.toMatchObject({ code: "CRM_CLIENT_INACTIVE" });
    mocks.client.mockResolvedValue({ client_id: "001", status: "prospect", blocked: false, archived_at: null }); mocks.owner.mockResolvedValue(false);
    await expect(executeCrmCommand("001", plan(), key, audit)).rejects.toMatchObject({ code: "CRM_OWNER_INACTIVE" });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("enforces contact ownership and external channel restrictions while retaining internal followups", async () => {
    mocks.contact.mockResolvedValue(false);
    await expect(executeCrmCommand("001", { ...plan(), contact_id: key }, key, audit)).rejects.toMatchObject({ code: "CRM_CONTACT_NOT_OF_CLIENT" });
    mocks.profile.mockResolvedValue({ ...emptyCrmProfile("001"), contact_policy: "DO_NOT_CONTACT" });
    await expect(executeCrmCommand("001", plan(), key, audit)).rejects.toMatchObject({ code: "CRM_CONTACT_RESTRICTED" });
    expect(mocks.create).not.toHaveBeenCalled();
    await executeCrmCommand("001", { ...plan(), channel: "INTERNAL" }, key, audit);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("keeps the previous due date and responsible user when reporting an allowed reschedule", async () => {
    const previous = { id: key, version: 4, status: "PLANNED", channel: "PHONE", contact_id: null, owner_user_id: 11, due_at: "2026-09-01T10:00:00Z" };
    mocks.read.mockResolvedValue(previous); mocks.change.mockImplementation(async (_tx, _id, input) => ({ ...previous, ...input, version: 5 }));
    const command = crmCommandSchema.parse({ action: "RESCHEDULE", followup_id: key, expected_version: 4, owner_user_id: 22,
      due_at: new Date(Date.now() + 86400000).toISOString(), reason: "CUSTOMER_REQUEST", note: null });
    await executeCrmCommand("001", command, key, audit);
    expect(mocks.event.mock.calls[0][1].details).toMatchObject({ previous_due_at: previous.due_at, previous_owner_user_id: 11, owner_user_id: 22, reason: "CUSTOMER_REQUEST", version: 5 });
    expect(mocks.audit.mock.calls[0][0].body.details).not.toHaveProperty("note");
  });
  it("allows closing an old reminder on an archived client and refuses a second closure", async () => {
    mocks.client.mockResolvedValue({ client_id: "001", status: "inactif", blocked: true, archived_at: "2026-01-01" });
    const previous = { id: key, version: 4, status: "PLANNED", owner_user_id: 11, due_at: "2026-01-01T10:00:00Z" };
    mocks.read.mockResolvedValue(previous); mocks.change.mockResolvedValue({ ...previous, version: 5, status: "COMPLETED", outcome: "CONTACTED" });
    const command = crmCommandSchema.parse({ action: "COMPLETE", followup_id: key, expected_version: 4, outcome: "CONTACTED", note: null });
    await executeCrmCommand("001", command, key, audit);
    mocks.read.mockResolvedValue({ ...previous, status: "COMPLETED" });
    await expect(executeCrmCommand("001", command, "e6115960-cc97-47d1-9df7-68391dc18cf4", audit)).rejects.toMatchObject({ code: "CRM_FOLLOWUP_CLOSED" });
    expect(mocks.change).toHaveBeenCalledTimes(1);
  });
});
