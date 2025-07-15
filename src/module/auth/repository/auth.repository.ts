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

