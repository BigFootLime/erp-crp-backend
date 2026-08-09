import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  compare: vi.fn(),
  loginLog: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("../module/auth/repository/auth.repository", () => ({
  findUserByUsername: mocks.findUser,
}));
vi.mock("../module/auth/repository/authLog.repository", () => ({ insertLoginLog: mocks.loginLog }));

import { loginUser } from "../module/auth/services/auth.service";

const previousSecret = process.env.JWT_SECRET;
const meta = { ip: null, user_agent: null, device_type: null, os: null, browser: null };

describe("login account lifecycle", () => {
  beforeAll(() => { process.env.JWT_SECRET = "sol-02-login-status-secret"; });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compare.mockResolvedValue(true);
  });

  it("returns the same generic authentication failure for a correct password on an inactive account", async () => {
    mocks.findUser.mockResolvedValue({
      id: 9,
      username: "INACTIVE.USER",
      email: "inactive@example.test",
      password: "hash",
      role: "Employee",
      roles: ["Employee"],
      status: "Inactive",
      realtime_session_epoch: "0",
    });

    await expect(loginUser("inactive.user", "Correct1!", meta)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_INVALID",
      message: "Identifiants invalides",
    });
    expect(mocks.loginLog).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 9,
      success: false,
      failure_reason: "ACCOUNT_NOT_ACTIVE",
    }));
  });
});
