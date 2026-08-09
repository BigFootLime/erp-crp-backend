import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'

const rateLimitMocks = vi.hoisted(() => ({
  check: vi.fn(async (endpoint: string, _subjects?: unknown) => ({ status: 'allowed', endpoint, disabled: false })),
}))

// 🛑 Place les mocks AVANT d'importer app
vi.mock('../module/auth/controllers/auth.controller', () => ({
  login: vi.fn((req, res) => res.status(200).json({ token: 'fake-jwt-token' })),
  forgotPassword: vi.fn((req, res) =>
    res.status(200).json({ message: 'Si ce compte existe, un lien de réinitialisation a été envoyé.' })
  ),
  resetPassword: vi.fn((req, res) => res.status(200).json({ message: 'Mot de passe réinitialisé' })),
}))

vi.mock('../module/auth/services/auth-rate-limit.service', () => ({
  authRateLimiter: {
    check: rateLimitMocks.check,
  },
}))

vi.mock('../module/auth/controllers/user.controller', () => ({
  getProfile: vi.fn((req, res) => res.status(200).json({ username: 'admin', role: 'Administrateur' })),
}))

vi.mock('../module/auth/middlewares/auth.middleware', () => ({
  authenticateToken: (req: { user: { id: number; role: string } }, res: any, next: () => void) => {
    req.user = { id: 1, role: 'Administrateur Systeme et Reseau' }
    next()
  },
  authorizeRole: (...roles: string[]) => (req: { user: { role: string } }, res: { status: (arg0: number) => { (): any; new(): any; json: { (arg0: { error: string }): any; new(): any } } }, next: () => any) => {
    if (roles.includes(req.user.role)) return next()
    return res.status(403).json({ error: 'Accès interdit' })
  }
}))

// ✅ importer app APRÈS les mocks
import app from '../config/app'

describe('🧪 Routes Authentification (/auth)', () => {
  it('🔒 POST /api/v1/auth/register est fermé et retourne 404', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'newuser',
        email: 'test@example.com',
        password: 'password123'
      })

    expect(res.status).toBe(404)
  })

  it('✅ POST /api/v1/auth/login retourne 200 avec un token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('token')
  })

  it('canonicalise les variantes Unicode du username avant le bucket login', async () => {
    rateLimitMocks.check.mockClear()

    await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'stra\u00dfe', password: 'password123' })
      .expect(200)

    expect(rateLimitMocks.check).toHaveBeenCalledWith(
      'login',
      expect.arrayContaining([{ dimension: 'username', value: 'STRASSE' }]),
    )
  })

  it('🔒 GET /api/v1/auth/me retourne les infos profil avec JWT + rôle', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer fake-jwt-token')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      username: 'admin',
      role: 'Administrateur'
    })
  })

  it('✅ POST /api/v1/auth/forgot-password retourne un message générique', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ usernameOrEmail: 'admin@example.com' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('message')
  })

  it('forgot-password consomme username et email sans classifier le compte', async () => {
    rateLimitMocks.check.mockClear()

    const usernameResponse = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ usernameOrEmail: 'adm\u0131n' })
    const emailResponse = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ usernameOrEmail: 'Person@Example.Test' })

    expect([usernameResponse.status, usernameResponse.body]).toEqual([emailResponse.status, emailResponse.body])
    const forgotCalls = rateLimitMocks.check.mock.calls.filter(([endpoint]) => endpoint === 'forgotPassword')
    expect(forgotCalls).toHaveLength(2)
    expect(forgotCalls[0]?.[1]).toEqual(expect.arrayContaining([
      { dimension: 'username', value: 'ADMIN' },
      { dimension: 'email', value: 'adm\u0131n' },
    ]))
    expect(forgotCalls[1]?.[1]).toEqual(expect.arrayContaining([
      { dimension: 'username', value: 'PERSON@EXAMPLE.TEST' },
      { dimension: 'email', value: 'person@example.test' },
    ]))
  })

  it('✅ POST /api/v1/auth/reset-password retourne 200', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'deadbeef', newPassword: 'P@ssw0rd-OK' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('message')
  })

  it('conserve le reset token opaque dans le bucket route', async () => {
    rateLimitMocks.check.mockClear()
    const token = ' AbC-opaque-token '

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'P@ssw0rd-OK' })
      .expect(200)

    expect(rateLimitMocks.check).toHaveBeenCalledWith(
      'resetPassword',
      expect.arrayContaining([{ dimension: 'token', value: token }]),
    )
  })

//   it('🚫 GET /api/v1/auth/me refuse l’accès si rôle non autorisé', async () => {
//   // Remock complet avec rôle non autorisé
//   vi.resetModules() // ⚠️ très important
//   vi.mock('../../modules/auth/middlewares/auth.middleware', () => ({
//     authenticateToken: (req, res, next) => {
//       req.user = { id: 1, role: 'Employé' } // ❌ pas autorisé
//       next()
//     },
//     authorizeRole: (...roles) => (req, res, next) => {
//       if (roles.includes(req.user.role)) return next()
//       return res.status(403).json({ error: 'Accès interdit' })
//     }
//   }))

//   // Re-importer l’app après les mocks mis à jour
//   const { default: appWithRestrictedRole } = await import('../config/app')

//   const res = await request(appWithRestrictedRole)
//     .get('/api/v1/auth/me')
//     .set('Authorization', 'Bearer fake-jwt-token')

//   expect(res.status).toBe(403)
//   expect(res.body).toEqual({ error: 'Accès interdit' })
// })

})
