import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'

// 🛑 Place les mocks AVANT d'importer app
vi.mock('../module/auth/controllers/auth.controller', () => ({
  register: vi.fn((req, res) => res.status(201).json({ message: 'Utilisateur enregistré' })),
  login: vi.fn((req, res) => res.status(200).json({ token: 'fake-jwt-token' })),
  forgotPassword: vi.fn((req, res) =>
    res.status(200).json({ message: 'Si ce compte existe, un lien de réinitialisation a été envoyé.' })
  ),
  resetPassword: vi.fn((req, res) => res.status(200).json({ message: 'Mot de passe réinitialisé' })),
}))

vi.mock('../module/auth/services/auth-rate-limit.service', () => ({
  authRateLimiter: {
    check: vi.fn(async (endpoint: string) => ({ status: 'allowed', endpoint, disabled: false })),
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
  it('✅ POST /api/v1/auth/register retourne 201', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'newuser',
        email: 'test@example.com',
        password: 'password123'
      })

    expect(res.status).toBe(201)
    expect(res.body.message).toBe('Utilisateur enregistré')
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

  it('✅ POST /api/v1/auth/reset-password retourne 200', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'deadbeef', newPassword: 'P@ssw0rd-OK' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('message')
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
