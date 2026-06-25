import { describe, test, vi, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('pg', () => {
    const emitter = new EventEmitter()

    return {
        Pool: vi.fn(() => emitter),
        __emitter__: emitter,
    }
})

const ENV_KEYS = [
    'DATABASE_URL',
    'PG_POOL_MAX',
    'PG_CONNECTION_TIMEOUT_MS',
    'PG_IDLE_TIMEOUT_MS',
    'PG_MAX_LIFETIME_SECONDS',
    'PG_STATEMENT_TIMEOUT_MS',
    'PG_QUERY_TIMEOUT_MS',
    'PG_LOCK_TIMEOUT_MS',
    'PG_IDLE_TX_TIMEOUT_MS',
] as const

const originalEnv = ENV_KEYS.reduce<Record<string, string | undefined>>((acc, key) => {
    acc[key] = process.env[key]
    return acc
}, {})

function restoreEnv() {
    for (const key of ENV_KEYS) {
        const original = originalEnv[key]
        if (typeof original === 'undefined') {
            delete process.env[key]
        } else {
            process.env[key] = original
        }
    }
}

describe('Connexion PostgreSQL', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        restoreEnv()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        restoreEnv()
    })

    test('initialise Pool avec DATABASE_URL et timeouts bornes', async () => {
        process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
        const { Pool } = await import('pg')
        const poolModule = await import('../config/database')

        expect(Pool).toHaveBeenCalledWith({
            connectionString: process.env.DATABASE_URL,
            max: 10,
            connectionTimeoutMillis: 5_000,
            idleTimeoutMillis: 30_000,
            maxLifetimeSeconds: 300,
            statement_timeout: 20_000,
            query_timeout: 25_000,
            lock_timeout: 5_000,
            idle_in_transaction_session_timeout: 15_000,
        })

        expect(poolModule.default).toBeDefined()
    })

    test('utilise les overrides env valides et ignore les valeurs invalides', async () => {
        process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
        process.env.PG_POOL_MAX = '16'
        process.env.PG_CONNECTION_TIMEOUT_MS = '7000'
        process.env.PG_IDLE_TIMEOUT_MS = '45000'
        process.env.PG_MAX_LIFETIME_SECONDS = '600'
        process.env.PG_STATEMENT_TIMEOUT_MS = '30000'
        process.env.PG_QUERY_TIMEOUT_MS = 'not-a-number'
        process.env.PG_LOCK_TIMEOUT_MS = '-1'
        process.env.PG_IDLE_TX_TIMEOUT_MS = '12000'

        const { Pool } = await import('pg')
        await import('../config/database')

        expect(Pool).toHaveBeenCalledWith({
            connectionString: process.env.DATABASE_URL,
            max: 16,
            connectionTimeoutMillis: 7_000,
            idleTimeoutMillis: 45_000,
            maxLifetimeSeconds: 600,
            statement_timeout: 30_000,
            query_timeout: 25_000,
            lock_timeout: 5_000,
            idle_in_transaction_session_timeout: 12_000,
        })
    })

    test('evenement connect declenche log', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { })

        const pg = await import('pg')
        await import('../config/database')

        ; (pg as any).__emitter__.emit('connect')

        expect(logSpy).toHaveBeenCalledWith('🟢 Connecté à PostgreSQL avec succès')
    })

    test('evenement error declenche erreur console', async () => {
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
