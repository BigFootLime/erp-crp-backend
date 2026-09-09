import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  account: vi.fn(),
  profile: vi.fn(),
  session: vi.fn(),
}));
vi.mock("../../config/database", () => ({
  default: {
    query: mocks.query,
    connect: async () => ({ query: mocks.query, release: vi.fn() }),
  },
}));
vi.mock("../auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: mocks.account,
}));
vi.mock("../access-control/services/access-control.service", () => ({
  resolveAccessProfile: mocks.profile,
}));
vi.mock("../production/repository/station.repository", () => ({
  repoFindSessionByToken: mocks.session,
  repoFindDeviceById: vi.fn(),
  repoOpenSession: vi.fn(),
}));
import { authenticateTerminalSession } from "./services/terminal-auth.service";
import {
  findTerminal,
  resolvePin,
  type Terminal,
} from "./repository/terminal-auth.repository";
const terminal = {
  id: "terminal-a",
  device_id: "device-a",
  site_code: "site",
  machine_id: "machine-a",
  auto_lock_seconds: 180,
  kind: "OPERATOR",
} as Terminal;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({
    rows: [{ terminal_id: "terminal-a", account_epoch: "2", valid: true }],
  });
  mocks.account.mockResolvedValue({
    id: 7,
    status: "Active",
    session_epoch: 2,
  });
  mocks.profile.mockResolvedValue({
    is_superadmin: false,
    modules: [{ module_key: "production", allowed: true }],
  });
  mocks.session.mockResolvedValue({
    session: {
      id: "session",
      device_id: "device-a",
      state: "ACTIVE",
      expires_at: new Date(Date.now() + 3600000),
      machine_id: "machine-a",
    },
    device: { status: "ACTIVE", workshop_zone: "A" },
    user: { id: 7, role: "Opérateur", username: "operator" },
  });
});
describe("device and operator authentication", () => {
  it("rejects unknown or revoked devices before any dossier query", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(findTerminal("unknown")).rejects.toMatchObject({
      status: 401,
    });
    expect(mocks.query.mock.calls[0][0]).toContain("t.revoked_at IS NULL");
  });
  it("rejects a session from another tablet", async () => {
    mocks.session.mockResolvedValue({ session: { device_id: "device-b" } });
    await expect(
      authenticateTerminalSession(terminal, "session"),
    ).rejects.toMatchObject({ code: "TERMINAL_SESSION_DEVICE" });
  });
  it("rejects a revoked PIN or expired inactivity window", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ terminal_id: "terminal-a", valid: false, account_epoch: "2" }],
    });
    await expect(
      authenticateTerminalSession(terminal, "session"),
    ).rejects.toMatchObject({ code: "TERMINAL_SESSION_LOCKED" });
  });
  it("invalidates the old operator after account revocation", async () => {
    mocks.account.mockResolvedValue({ status: "Active", session_epoch: 3 });
    await expect(
      authenticateTerminalSession(terminal, "session"),
    ).rejects.toMatchObject({ code: "TERMINAL_ACCOUNT_REJECTED" });
  });
  it("invalidates a session when the production grant is removed", async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [] });
    await expect(
      authenticateTerminalSession(terminal, "session"),
    ).rejects.toMatchObject({ code: "TERMINAL_SESSION_ACCESS_REVOKED" });
  });
  it("permits the same operator on another independently verified machine", async () => {
    const a = await authenticateTerminalSession(terminal, "session");
    expect(a.user.id).toBe(7);
    expect(a.machine_id).toBe("machine-a");
    expect(mocks.query.mock.calls[0][0]).not.toContain("UPDATE");
  });
  it("commits failed PIN counters and blocks after five failures", async () => {
    const buckets = new Map<string, { attempts: number; locked: boolean }>();
    mocks.query.mockImplementation(
      async (sql: string, args: unknown[] = []) => {
        const name = String(args[0]);
        if (sql.includes("INSERT INTO public.cerp_terminal_rate_limits"))
          buckets.set(
            name,
            buckets.get(name) ?? { attempts: 0, locked: false },
          );
        if (sql.includes("SELECT locked_until"))
          return { rows: [{ locked: buckets.get(name)?.locked }] };
        if (sql.includes("attempts=attempts+1")) {
          const b = buckets.get(name)!;
          b.attempts++;
          b.locked = b.attempts >= Number(args[1]);
        }
        return { rows: [] };
      },
    );
    for (let i = 0; i < 5; i++)
      expect((await resolvePin(terminal, "hash")).ok).toBe(false);
    expect(await resolvePin(terminal, "hash")).toEqual({
      ok: false,
      locked: true,
    });
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql === "COMMIT"),
    ).toHaveLength(6);
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql === "ROLLBACK"),
    ).toHaveLength(0);
  });
});
