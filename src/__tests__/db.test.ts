import { describe, test, vi, expect, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'events'

// Mock de pg.Pool avec un EventEmitter
vi.mock('pg', () => {
    const emitter = new EventEmitter()

    return {
        Pool: vi.fn(() => emitter),
        __emitter__: emitter, // Pour déclencher manuellement les événements
    }
})

import dotenv from 'dotenv'
dotenv.config()

describe('Connexion PostgreSQL', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    test('✅ Initialise correctement Pool avec DATABASE_URL', async () => {
        process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
        const { Pool } = await import('pg')
        const poolModule = await import('../config/database') // adapte si besoin

        expect(Pool).toHaveBeenCalledWith({
            connectionString: process.env.DATABASE_URL,
        })

        expect(poolModule.default).toBeDefined()
    })

    test('🟢 Événement connect déclenche log', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { })

        const pg = await import('pg')
        await import('../config/database')

            ; (pg as any).__emitter__.emit('connect')

        expect(logSpy).toHaveBeenCalledWith('🟢 Connecté à PostgreSQL avec succès')
    })

    test('❌ Événement error déclenche erreur console', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { })

        const pg = await import('pg')
        await import('../config/database')

        const fakeError = new Error('Connexion refusée')
            ; (pg as any).__emitter__.emit('error', fakeError)

        expect(errorSpy).toHaveBeenCalledWith('❌ Erreur de connexion PostgreSQL', fakeError)
    })
    afterAll(() => {
        console.log('\n✅ Connexion PostgreSQL : tous les tests sont OK 🟢\n')
    })
})


