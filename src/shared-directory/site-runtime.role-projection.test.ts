import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorySession } from "./model";
import {
  directoryAuthenticationResult,
  initializeSharedDirectorySite,
  projectDirectoryIdentity,
  validateSiteDirectoryToken,
} from "./site-runtime";

const authority = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
  validate: vi.fn(),
}));

vi.mock("./client", () => ({
  DirectoryClient: class {
    call = async () => ({ directory_id: authority.id, schema_version: 1 });
    validate = authority.validate;
  },
  LOCAL_DIRECTORY_ENDPOINT: "",
}));
vi.mock("./common-access", () => ({ synchronizeCommonAccess: vi.fn() }));
vi.mock("./company.projection", () => ({ synchronizeDirectoryCompany: vi.fn() }));

const jwtSecret = "fixture-only-role-projection-signing-secret";
const directorySession = "fixture-directory-session";
const profile: DirectorySession = {
  profile_id: "22222222-2222-4222-8222-222222222222",
  source_user_id: 7,
  database: "cerp_test",
  username: "FIXTURE",
  name: "Fixture",
  surname: "Outillage",
  email: null,
  avatar_key: null,
  avatar_asset_id: null,
  tel_no: null,
  role: "Fraisage",
  roles: ["Fraisage", "Études-Méthodes"],
  is_superadmin: false,
  status: "Active",
  job_title: null,
  employment_type: null,
  weekly_hours_target: null,
  work_profile_incomplete: false,
  work_profile: null,
  work_profile_start_date: null,
  mfa_reenrollment_required: false,
  global_session_epoch: 9,
  membership_version: 2,
  mfa_factor_id: null,
  mfa_factor_version: null,
  mfa_verified_at: null,
  mfa_method: null,
};

function database() {
  // An accent-aware SQL collation puts Études before Fraisage. JavaScript's
  // default UTF-16 ordering sorts the same two assignments the other way.
  const state = { roles: ["Études-Méthodes", "Fraisage"], epoch: 41, name: profile.name, membershipVersion: profile.membership_version };
  const assignments = () => [...state.roles].sort((left, right) => left.localeCompare(right, "fr-FR"));
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT current_database()")) return { rows: [{ database: profile.database }] };
    if (sql.includes("SELECT to_regclass")) return { rows: [{ ok: true }] };
    if (sql.includes("array_agg(r.role_key")) return { rows: [{
      id: 13,
      directory_username: profile.username,
      name: state.name,
      surname: profile.surname,
      directory_email: profile.email,
      role: profile.role,
      status: profile.status,
      is_superadmin: profile.is_superadmin,
      avatar_key: profile.avatar_key,
      directory_avatar_asset_id: null,
      tel_no: profile.tel_no,
      mfa_reenrollment_required: profile.mfa_reenrollment_required,
      directory_profile_metadata: {
        job_title: profile.job_title,
        employment_type: profile.employment_type,
        weekly_hours_target: profile.weekly_hours_target,
        work_profile_incomplete: profile.work_profile_incomplete,
      },
      roles: assignments(),
      work_profile_bound: false,
      source_user_id: profile.source_user_id,
      global_session_epoch: String(profile.global_session_epoch),
      membership_version: state.membershipVersion,
      mfa_factor_id: null,
      mfa_factor_version: null,
      session_epoch: String(state.epoch),
    }] };
    throw new Error("Unexpected projection query");
  });
  const transactionQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT id FROM public.users")) return { rows: [{ id: 13 }] };
    if (sql.includes("SELECT role_key FROM public.user_role_assignments")) return { rows: assignments().map(role_key => ({ role_key })) };
    if (sql.startsWith("DELETE FROM public.user_role_assignments")) {
      // Match the per-row session epoch trigger in the PostgreSQL store.
      state.epoch += state.roles.length;
      state.roles = [];
    }
    if (sql.startsWith("INSERT INTO public.user_role_assignments")) {
      state.roles.push(String(values[1]));
      state.epoch += 1;
    }
    if (sql.startsWith("UPDATE public.users SET directory_username")) state.name = String(values[2]);
    if (sql.startsWith("INSERT INTO public.cerp_directory_projection_state")) state.membershipVersion = Number(values[4]);
    if (sql.includes("::text AS epoch")) return { rows: [{ epoch: String(state.epoch) }] };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query: transactionQuery, release: vi.fn() }));
  return { pool: { connect, query } as unknown as Pool, connect, state };
}

async function signIn(pool: Pool, identity: DirectorySession) {
  const result = await directoryAuthenticationResult(pool, { directory_session: directorySession, identity });
  return jwt.verify(String(result.token), jwtSecret) as Parameters<typeof validateSiteDirectoryToken>[1];
}

describe("Directory role projection and session epochs", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", jwtSecret);
    vi.stubEnv("CERP_BUSINESS_COMPANIES_ENABLED", "false");
    authority.validate.mockResolvedValue(profile);
  });
  afterEach(() => {
    authority.validate.mockReset();
    vi.unstubAllEnvs();
  });

  async function testSite(pool: Pool) {
    await initializeSharedDirectorySite(pool, {
      CERP_SHARED_DIRECTORY_ENABLED: "true",
      CERP_SHARED_DIRECTORY_SITE: profile.database,
      CERP_SHARED_DIRECTORY_ID: authority.id,
    });
  }

  it("keeps the newly issued token valid across repeated requests for the same role assignments", async () => {
    const { pool, state, connect } = database();
    expect(state.roles).not.toEqual([...profile.roles].sort());
    await testSite(pool);
    const claims = await signIn(pool, profile);
    await expect(validateSiteDirectoryToken(pool, claims)).resolves.toMatchObject({ roles: profile.roles });
    await expect(validateSiteDirectoryToken(pool, claims)).resolves.toMatchObject({ role: profile.role });
    expect(claims.session_epoch).toBe(41);
    expect(state.epoch).toBe(41);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps role assignments during a separate profile change", async () => {
    const { pool, state } = database();
    await testSite(pool);
    const changed = { ...profile, name: "Nouveau prénom" };
    await expect(projectDirectoryIdentity(pool, changed)).resolves.toEqual({ id: 13, session_epoch: 41 });
    expect(state.name).toBe(changed.name);
    expect(state.roles).toEqual(["Études-Méthodes", "Fraisage"]);
    expect(state.epoch).toBe(41);
  });

  it("projects a real role change and rejects an outdated or revoked session", async () => {
    const { pool, state } = database();
    await testSite(pool);
    const originalClaims = await signIn(pool, profile);
    const changed = { ...profile, roles: ["Fraisage", "Livraison"], membership_version: 3 };
    authority.validate.mockResolvedValue(changed);
    const changedClaims = await signIn(pool, changed);

    expect(state.roles).toEqual(changed.roles);
    expect(changedClaims.session_epoch).toBeGreaterThan(originalClaims.session_epoch!);
    await expect(validateSiteDirectoryToken(pool, originalClaims)).rejects.toThrow("DIRECTORY_SESSION_STALE");
    await expect(validateSiteDirectoryToken(pool, changedClaims)).resolves.toMatchObject({ roles: changed.roles });
    state.epoch += 1;
    await expect(validateSiteDirectoryToken(pool, changedClaims)).rejects.toThrow("DIRECTORY_LOCAL_SESSION_STALE");
  });
});
