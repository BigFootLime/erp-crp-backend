import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('🟢 Connecté à PostgreSQL avec succès');
});

pool.on('error', (err) => {
  console.error('❌ Erreur de connexion PostgreSQL', err);
});

export default pool;
