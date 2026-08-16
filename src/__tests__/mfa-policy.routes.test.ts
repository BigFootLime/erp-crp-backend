import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mfa = vi.hoisted(() => ({
  status: vi.fn(),
  enroll: vi.fn(),
  policy: vi.fn(),
  updatePolicy: vi.fn(),
}))
const access = vi.hoisted(() => ({ isSuperadmin: vi.fn() }))

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: unknown; headers: Record<string, unknown> },
    res: { status: (status: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    const raw = req.headers["x-test-user-id"]
    if (typeof raw !== "string") {
      res.status(401).json({ error: "Token manquant ou invalide" })
      return
    }
    req.user = { id: Number(raw), username: "TEST", email: "test@example.test", role: "Employee" }
    next()
  },
}))

vi.mock("../module/auth/middlewares/auth-rate-limit.middleware", () => ({
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  mfaRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  forgotPasswordRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  resetPasswordRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock("../module/access-control/services/access-control.service", () => ({
  isSuperadmin: access.isSuperadmin,
}))

vi.mock("../module/auth/services/mfa.service", () => ({
  getMfaStatus: mfa.status,
  beginOwnMfaEnrollment: mfa.enroll,
  getMfaPolicyConfiguration: mfa.policy,
  updateMfaPolicyConfiguration: mfa.updatePolicy,
  beginMfaReplacement: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  revokeOwnMfa: vi.fn(),
  stepUpMfa: vi.fn(),
  verifyMfaChallenge: vi.fn(),
}))

import authRouter from "../module/auth/routes/auth.routes"

function testApp() {
  const app = express()
  app.use(express.json())
  app.use("/auth", authRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400
    res.status(status).json({ error: "request_failed" })
  })
  return app
}

describe("MFA policy and self-service routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    access.isSuperadmin.mockResolvedValue(false)
    mfa.status.mockResolvedValue({ policy: "optional", enrolled: false, can_enroll: true })
    mfa.enroll.mockResolvedValue({ status: "mfa_enrollment_required", challenge_token: "opaque" })
    mfa.policy.mockResolvedValue({ policy: "required_for_admins" })
    mfa.updatePolicy.mockResolvedValue({ policy: "required_for_all", changed: true })
  })

  it("refuse les lectures et enrôlements anonymes", async () => {
    await request(testApp()).get("/auth/mfa/status").expect(401)
    await request(testApp()).post("/auth/mfa/enrollment").send({ current_password: "password" }).expect(401)
    expect(mfa.status).not.toHaveBeenCalled()
    expect(mfa.enroll).not.toHaveBeenCalled()
  })

  it("autorise l’utilisateur authentifié à consulter son statut et commencer son enrôlement", async () => {
    await request(testApp()).get("/auth/mfa/status").set("x-test-user-id", "12").expect(200)
    const response = await request(testApp())
      .post("/auth/mfa/enrollment")
      .set("x-test-user-id", "12")
      .send({ current_password: "correct horse battery staple", device_label: "Téléphone atelier" })
      .expect(200)
    expect(response.body.status).toBe("mfa_enrollment_required")
    expect(mfa.enroll).toHaveBeenCalledWith(12, "correct horse battery staple", "Téléphone atelier", expect.objectContaining({ path: "/auth/mfa/enrollment" }))
  })

  it("réserve la politique au statut superadministrateur lu en direct", async () => {
    await request(testApp()).get("/auth/mfa/policy").set("x-test-user-id", "12").expect(403)
    expect(mfa.policy).not.toHaveBeenCalled()

    access.isSuperadmin.mockResolvedValueOnce(true)
    await request(testApp()).get("/auth/mfa/policy").set("x-test-user-id", "4").expect(200)
    expect(mfa.policy).toHaveBeenCalledOnce()
  })

  it("valide puis transmet une modification de politique authentifiée", async () => {
    access.isSuperadmin.mockResolvedValueOnce(true)
    await request(testApp())
      .put("/auth/mfa/policy")
      .set("x-test-user-id", "4")
      .send({ policy: "required_for_all", current_password: "current-password", code: "123456" })
      .expect(200)
    expect(mfa.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ userId: 4, policy: "required_for_all", password: "current-password", code: "123456" }))
  })
})
