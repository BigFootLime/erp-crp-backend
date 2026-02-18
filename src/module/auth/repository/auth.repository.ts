import pool from '../../../config/database';
import { CreateUserDTO } from '../types/user.type';

export const createUser = async (user: CreateUserDTO, hashedPassword: string) => {
  const client = await pool.connect();
  try {
    const {
      username, name, surname, email, tel_no, gender, address, lane,
      house_no, postcode, country = 'France', salary = 0,
      date_of_birth, role = 'Utilisateur', social_security_number
    } = user;

    const result = await client.query(
      `INSERT INTO users (
        username, password, name, surname, email, tel_no, gender, address,
        lane, house_no, postcode, country, salary, date_of_birth, role, social_security_number
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING id, username, email, role;`,
      [
        username, hashedPassword, name, surname, email, tel_no, gender, address,
        lane, house_no, postcode, country, salary, date_of_birth, role, social_security_number
      ]
    );

    return result.rows[0];
  } finally {
    client.release();
  }
};

// 🔍 Cherche un utilisateur par email
export const findUserByUsername = async (username: string) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    return result.rows[0]; // undefined si pas trouvé
  } finally {
    client.release();
  }
};

export type AuthUserLookupRow = {
  id: number;
  username: string;
  email: string | null;
  password?: string;
};

export const findUserByUsernameOrEmail = async (usernameOrEmail: string): Promise<AuthUserLookupRow | null> => {
  const raw = typeof usernameOrEmail === "string" ? usernameOrEmail.trim() : "";
  if (!raw) return null;

  const normalizedUsername = raw.toUpperCase();
  const normalizedEmail = raw.toLowerCase();

  const client = await pool.connect();
  try {
    const result = await client.query<AuthUserLookupRow>(
      `
        SELECT id, username, email, password
        FROM users
        WHERE username = $1
           OR LOWER(email) = $2
        LIMIT 1
      `,
      [normalizedUsername, normalizedEmail]
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
};

export const updateUserPassword = async (params: { userId: number; passwordHash: string; tx?: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }) => {
  const q = params.tx ?? pool;
  await q.query(
    `
      UPDATE users
      SET password = $1
      WHERE id = $2
    `,
    [params.passwordHash, params.userId]
  );
};

