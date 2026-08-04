import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Request, Response } from 'express'
import { forgotPassword, register, login } from '../module/auth/controllers/auth.controller'
import { ZodError, ZodIssueCode } from "zod"

// 🔧 Mocks
vi.mock('../module/auth/validators/user.validator', () => ({
  registerSchema: {
    parse: vi.fn()
  }
}))
vi.mock('../module/auth/validators/auth.validator', () => ({
  loginSchema: {
    parse: vi.fn()
  },
  forgotPasswordSchema: {
    safeParse: vi.fn()
  },
  resetPasswordSchema: {
    parse: vi.fn()
  }
}))
vi.mock('../module/auth/services/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn()
}))

import * as mockedRegisterValidator from '../module/auth/validators/user.validator'
import * as mockedLoginValidator from '../module/auth/validators/auth.validator'
import * as mockedAuthService from '../module/auth/services/auth.service'

const mockedRegisterParse = mockedRegisterValidator.registerSchema.parse as unknown as ReturnType<typeof vi.fn>
const mockedLoginParse = mockedLoginValidator.loginSchema.parse as unknown as ReturnType<typeof vi.fn>
const mockedForgotSafeParse = mockedLoginValidator.forgotPasswordSchema.safeParse as unknown as ReturnType<typeof vi.fn>
const mockedRegisterUser = mockedAuthService.registerUser as unknown as ReturnType<typeof vi.fn>
const mockedLoginUser = mockedAuthService.loginUser as unknown as ReturnType<typeof vi.fn>
const mockedRequestPasswordReset = mockedAuthService.requestPasswordReset as unknown as ReturnType<typeof vi.fn>

describe('🧪 auth.controller.ts', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let jsonMock: any
  let statusMock: any

  beforeEach(() => {
    jsonMock = vi.fn()
    statusMock = vi.fn(() => ({ json: jsonMock }))

    req = { body: {}, headers: {} }
    res = { status: statusMock } as Response

    vi.clearAllMocks()
  })

  test('✅ register crée un utilisateur et renvoie 201', async () => {
    const mockUser = { id: 1, username: 'admin' }

    mockedRegisterParse.mockReturnValue({
      username: 'admin',
      employment_date: '2025-01-01'
    })

    mockedRegisterUser.mockResolvedValue(mockUser)

    await register(req as Request, res as Response, vi.fn())

    expect(statusMock).toHaveBeenCalledWith(201)
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Utilisateur créé avec succès',
      user: mockUser
    })
  })

  test('❌ register retourne 400 si date de fin < date embauche', async () => {
    mockedRegisterParse.mockImplementation(() => {
      throw new ZodError([
        {
          code: ZodIssueCode.custom,
          path: ["employment_end_date"],
          message: "La date de fin d’emploi doit être postérieure à la date d’embauche",
          params: {},
        },
      ])
    })

    const nextMock = vi.fn()
    await register(req as Request, res as Response, nextMock)

    expect(statusMock).toHaveBeenCalledTimes(0)
    expect(jsonMock).toHaveBeenCalledTimes(0)
    expect(nextMock).toHaveBeenCalledTimes(1)
    expect(nextMock.mock.calls[0]?.[0]).toBeInstanceOf(ZodError)
  })

  test('✅ login renvoie un token si identifiants valides', async () => {
    mockedLoginParse.mockReturnValue({
      username: 'admin',
      password: 'secret'
    })

    mockedLoginUser.mockResolvedValue({
      token: 'fake-jwt',
      user: { id: 1, username: 'admin' }
    })

    await login(req as Request, res as Response, vi.fn())

    expect(statusMock).toHaveBeenCalledWith(200)
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Connexion réussie',
      token: 'fake-jwt',
      user: { id: 1, username: 'admin' }
    })
  })

  test('🔒 forgot-password conserve le message générique sans effet quand le middleware supprime l’action', async () => {
    vi.useFakeTimers()
    mockedForgotSafeParse.mockReturnValue({
      success: true,
      data: { usernameOrEmail: 'person@example.test' }
    })
    req = {
      body: { usernameOrEmail: 'person@example.test' },
      headers: {},
      authRateLimit: { suppressAction: true, reason: 'blocked' },
      originalUrl: '/api/v1/auth/forgot-password'
    }

    const pending = forgotPassword(req as Request, res as Response, vi.fn())
    await vi.advanceTimersByTimeAsync(600)
    await pending

    expect(mockedRequestPasswordReset).not.toHaveBeenCalled()
    expect(statusMock).toHaveBeenCalledWith(200)
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Si ce compte existe, un lien de réinitialisation a été envoyé.'
    })
    vi.useRealTimers()
  })
})
