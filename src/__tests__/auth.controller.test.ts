import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Request, Response } from 'express'
import { register, login } from '../module/auth/controllers/auth.controller'

// 🔧 Mocks
vi.mock('../module/auth/validators/user.validator', () => ({
  registerSchema: {
    parse: vi.fn()
  }
}))
vi.mock('../module/auth/validators/auth.validator', () => ({
  loginSchema: {
    parse: vi.fn()
  }
}))
vi.mock('../module/auth/services/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn()
}))

import * as mockedRegisterValidator from '../module/auth/validators/user.validator'
import * as mockedLoginValidator from '../module/auth/validators/auth.validator'
import * as mockedAuthService from '../module/auth/services/auth.service'

const mockedRegisterSchema = mockedRegisterValidator.registerSchema
const mockedLoginSchema = mockedLoginValidator.loginSchema

describe('🧪 auth.controller.ts', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let jsonMock: any
  let statusMock: any

  beforeEach(() => {
    jsonMock = vi.fn()
    statusMock = vi.fn(() => ({ json: jsonMock }))

    req = { body: {} }
    res = { status: statusMock } as Response

    vi.clearAllMocks()
  })

  test('✅ register crée un utilisateur et renvoie 201', async () => {
    const mockUser = { id: 1, username: 'admin' }

    mockedRegisterSchema.parse.mockReturnValue({
      username: 'admin',
      employment_date: '2025-01-01'
    })

    mockedAuthService.registerUser.mockResolvedValue(mockUser)

    await register(req as Request, res as Response, vi.fn())

    expect(statusMock).toHaveBeenCalledWith(201)
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Utilisateur créé avec succès',
      user: mockUser
    })
  })

  test('❌ register retourne 400 si date de fin < date embauche', async () => {
    mockedRegisterSchema.parse.mockReturnValue({
      username: 'admin',
      employment_date: '2025-01-01',
      employment_end_date: '2023-01-01'
    })

    await register(req as Request, res as Response, vi.fn())

    expect(statusMock).toHaveBeenCalledWith(400)
    expect(jsonMock).toHaveBeenCalledWith({
      error: "La date de fin d’emploi doit être postérieure à la date d’embauche"
    })
  })

  test('✅ login renvoie un token si identifiants valides', async () => {
    mockedLoginSchema.parse.mockReturnValue({
      username: 'admin',
      password: 'secret'
    })

    mockedAuthService.loginUser.mockResolvedValue({
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
})
