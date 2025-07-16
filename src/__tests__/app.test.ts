import request from 'supertest'
import { describe, it, expect, vi } from 'vitest'
import app from '../config/app' // adapte si le chemin change
import * as checkDrive from '../utils/checkNetworkDrive'

// Mock du checkNetworkDrive pour éviter l'erreur console
vi.mock('../utils/checkNetworkDrive', () => ({
    checkNetworkDrive: vi.fn(() => Promise.resolve())
}))

describe('Test de l\'application Express ERP', () => {
    it('✅ GET / doit renvoyer un message de confirmation', async () => {
        const res = await request(app).get('/')
        expect(res.status).toBe(200)
        expect(res.text).toContain('Backend ERP en ligne')
    })

    it('✅ GET /api/v1 doit répondre correctement', async () => {
        const res = await request(app).get('/api/v1')
        expect(res.status).toBe(200)
        expect(res.text).toContain('Backend ERP en ligne en V1')
    })

    it('🌐 Test CORS headers', async () => {
        const res = await request(app).get('/')
        expect(res.headers['access-control-allow-origin']).toBe('*')
    })

    it('🪪 Vérifie les en-têtes sécurisés de Helmet', async () => {
        const res = await request(app).get('/')
        expect(res.headers).toHaveProperty('x-dns-prefetch-control')
        expect(res.headers).toHaveProperty('x-frame-options')
        expect(res.headers).toHaveProperty('strict-transport-security')
    })
})
